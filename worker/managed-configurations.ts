import { CAPABILITY } from "../shared/domain";
import {
  MANAGED_CONFIGURATION_CUSTODY,
  MANAGED_CONFIGURATION_LIMITS,
  MANAGED_CONFIGURATION_STATUS,
  managedDestinationKey,
  managedConfigurationInput,
  managedConfigurationListInput,
  managedConfigurationSchema,
  managedConfigurationSaveInput,
  managedConfigurationStatus,
  managedConfigurationStopInput,
  type ManagedConfiguration,
  type ManagedConfigurationDestination,
  type ManagedConfigurationFields,
  type ManagedConfigurationObservation,
  type ManagedProviderSnapshot,
} from "../shared/managed-configurations";
import {
  SECRET_ENTRY_KIND,
  SECRET_MANAGEMENT,
  SECRET_PROVIDER_KIND,
  type SecretEntryKind,
  type SecretProviderKind,
  type SecretScope,
} from "../shared/secrets";
import {
  GITHUB_SECRET_LIMITS,
  secretNameSchema,
  secretVariableMetadataSchema,
} from "../shared/github-secrets";
import {
  authorizeHooks as authorize,
  hookActorGuard as actorGuard,
} from "./hook-authority";
import { DomainError } from "./errors";
import { SecretsService } from "./secrets";
import type { WorkspaceService } from "./service";

type ConfigurationRow = {
  workspace_id: string;
  id: string;
  label: string;
  entry_kind: SecretEntryKind;
  custody: "none";
  desired_value: string | null;
  state: "active" | "stopped";
  revision: number;
  created_at: string;
  updated_at: string;
  write_id: string;
};
type DestinationRow = {
  configuration_id: string;
  destination_index: number;
  destination_key: string;
  entry_kind: SecretEntryKind;
  provider_kind: SecretProviderKind;
  connection_provider_kind: SecretProviderKind;
  connection_id: string;
  connection_revision: number;
  resource_id: string;
  scope_kind: SecretScope["kind"];
  scope_name: string;
  provider_name: string;
  desired_state: ManagedConfigurationDestination["desiredState"];
};
export type SelectedManagedDestination = {
  connection: Awaited<ReturnType<SecretsService["resource"]>>;
  destination: ManagedConfigurationDestination;
};

const CONFIGURATION_COLUMNS =
  "workspace_id,id,label,entry_kind,custody,desired_value,state,revision,created_at,updated_at,write_id";
const DESTINATION_COLUMNS = `d.configuration_id,d.destination_index,d.destination_key,d.entry_kind,d.connection_id,c.revision AS connection_revision,
  d.provider_kind,c.provider_kind AS connection_provider_kind,d.resource_id,d.scope_kind,d.scope_name,d.provider_name,d.desired_state`;

function rowScope(row: DestinationRow): SecretScope {
  return row.scope_kind === "environment" || row.scope_kind === "organization"
    ? { kind: row.scope_kind, name: row.scope_name }
    : { kind: row.scope_kind };
}

function rowDestination(row: DestinationRow): ManagedConfigurationDestination {
  return {
    destination: {
      connectionId: row.connection_id,
      connectionRevision: row.connection_revision,
      target: { resourceId: row.resource_id, scope: rowScope(row) },
      name: row.provider_name,
    },
    desiredState: row.desired_state,
  };
}

export class ManagedConfigurations {
  readonly secrets: SecretsService;
  constructor(readonly context: WorkspaceService) {
    this.secrets = new SecretsService(context);
  }
  get db() {
    return this.context.db;
  }
  timestamp() {
    return new Date(this.context.now()).toISOString();
  }
  conflict(): never {
    throw new DomainError(
      "managed_configuration_conflict",
      "This managed configuration changed or has an active operation. Keep your draft and reload its saved state.",
      409,
    );
  }

  private invalid(): never {
    throw new DomainError(
      "managed_configuration_invalid",
      "This managed configuration has inconsistent stored metadata. Ask the workspace owner to repair it.",
      503,
    );
  }

  private async row(workspaceId: string, configurationId: string) {
    const guard = actorGuard(this.context, workspaceId);
    const row = await this.db
      .prepare(
        `SELECT ${CONFIGURATION_COLUMNS} FROM managed_configurations WHERE workspace_id=? AND id=? AND ${guard.sql}`,
      )
      .bind(workspaceId, configurationId, ...guard.values)
      .first<ConfigurationRow>();
    if (!row)
      throw new DomainError(
        "not_found",
        "Managed configuration not found or access changed.",
        404,
      );
    return row;
  }

  private async destinationRows(
    workspaceId: string,
    configurationIds: string[],
  ) {
    if (!configurationIds.length) return [];
    const guard = actorGuard(this.context, workspaceId);
    return (
      await this.db
        .prepare(
          `SELECT ${DESTINATION_COLUMNS} FROM managed_configuration_destinations d
        JOIN secret_connections c ON c.workspace_id=d.workspace_id AND c.id=d.connection_id
        WHERE d.workspace_id=? AND d.configuration_id IN (SELECT value FROM json_each(?)) AND ${guard.sql}
        ORDER BY d.configuration_id,d.destination_index`,
        )
        .bind(
          workspaceId,
          JSON.stringify(configurationIds),
          ...guard.values,
        )
        .all<DestinationRow>()
    ).results;
  }

  private describe(
    row: ConfigurationRow,
    destinations: DestinationRow[],
  ): ManagedConfiguration {
    if (
      !destinations.length ||
      destinations.some(
        (item, index) =>
          item.destination_index !== index ||
          item.entry_kind !== row.entry_kind ||
          item.provider_kind !== item.connection_provider_kind ||
          item.destination_key !==
            managedDestinationKey(
              item.provider_kind,
              item.entry_kind,
              rowDestination(item).destination,
            ),
      )
    )
      this.invalid();
    const common = {
      id: row.id,
      label: row.label,
      custody: MANAGED_CONFIGURATION_CUSTODY.NONE,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      destinations: destinations.map(rowDestination),
    };
    const described =
      row.entry_kind === SECRET_ENTRY_KIND.SECRET
        ? {
            ...common,
            entryKind: SECRET_ENTRY_KIND.SECRET,
            desiredValue: null,
          }
        : {
            ...common,
            entryKind: SECRET_ENTRY_KIND.VARIABLE,
            desiredValue: row.desired_value!,
          };
    const parsed = managedConfigurationSchema.safeParse(described);
    if (!parsed.success) this.invalid();
    return parsed.data;
  }

  async list(input: unknown) {
    const { workspaceId } = managedConfigurationListInput.parse(input);
    await authorize(this.context, workspaceId);
    const guard = actorGuard(this.context, workspaceId);
    const rows = await this.db
      .prepare(
        `SELECT ${CONFIGURATION_COLUMNS} FROM managed_configurations WHERE workspace_id=? AND state='active' AND ${guard.sql}
      ORDER BY label,id LIMIT ?`,
      )
      .bind(
        workspaceId,
        ...guard.values,
        MANAGED_CONFIGURATION_LIMITS.CONFIGURATIONS + 1,
      )
      .all<ConfigurationRow>();
    if (rows.results.length > MANAGED_CONFIGURATION_LIMITS.CONFIGURATIONS)
      throw new DomainError(
        "capacity",
        "Managed configurations exceed the supported workspace limit.",
        409,
      );
    const destinations = await this.destinationRows(
      workspaceId,
      rows.results.map((row) => row.id),
    );
    await authorize(this.context, workspaceId);
    return rows.results.map((row) =>
      this.describe(
        row,
        destinations.filter((item) => item.configuration_id === row.id),
      ),
    );
  }

  async configuration(workspaceId: string, configurationId: string) {
    await authorize(this.context, workspaceId);
    const row = await this.row(workspaceId, configurationId);
    if (row.state !== "active")
      throw new DomainError(
        "not_found",
        "Managed configuration is no longer active.",
        404,
      );
    const destinations = await this.destinationRows(workspaceId, [row.id]);
    await authorize(this.context, workspaceId);
    return this.describe(row, destinations);
  }

  private activeOperationSql(alias = "managed_configurations") {
    return `NOT EXISTS (SELECT 1 FROM managed_configuration_reviews mr JOIN operations o ON o.plan_id=mr.plan_id
      WHERE mr.workspace_id=${alias}.workspace_id AND mr.configuration_id=${alias}.id
      AND o.status IN ('pending','running','partial','indeterminate'))`;
  }

  private async normalizeDestination(
    workspaceId: string,
    entryKind: SecretEntryKind,
    item: ManagedConfigurationDestination,
  ): Promise<SelectedManagedDestination> {
    const selected = await this.secrets.resource(
      workspaceId,
      item.destination.connectionId,
      item.destination.target.resourceId,
    );
    if (selected.row.revision !== item.destination.connectionRevision)
      this.conflict();
    if (
      selected.row.provider_kind !== SECRET_PROVIDER_KIND.GITHUB ||
      !selected.provider.inspectManaged ||
      !selected.adapter.capabilities.entryKinds.includes(entryKind) ||
      !["repository", "environment"].includes(
        item.destination.target.scope.kind,
      )
    )
      throw new DomainError(
        "managed_configuration_unsupported",
        "This provider, configuration kind, or scope is inventory-only in the managed workflow.",
        409,
      );
    const name = secretNameSchema.safeParse(item.destination.name);
    if (!name.success)
      throw new DomainError(
        "secret_name_invalid",
        "Choose a valid GitHub Actions configuration name without the reserved GITHUB_ prefix.",
        400,
      );
    return {
      connection: selected,
      destination: {
        destination: { ...item.destination, name: name.data },
        desiredState: item.desiredState,
      },
    };
  }

  private async conflicts(
    workspaceId: string,
    configurationId: string,
    providerKind: SecretProviderKind,
    entryKind: SecretEntryKind,
    destinations: ManagedConfigurationDestination[],
  ) {
    if (!destinations.length) return false;
    const keys = destinations.map((item) =>
      managedDestinationKey(providerKind, entryKind, item.destination),
    );
    if (new Set(keys).size !== keys.length) return true;
    return Boolean(
      await this.db
        .prepare(
          `SELECT configuration_id FROM managed_configuration_destinations
          WHERE workspace_id=? AND destination_key IN (SELECT value FROM json_each(?))
            AND configuration_id<>? LIMIT 1`,
        )
        .bind(workspaceId, JSON.stringify(keys), configurationId)
        .first(),
    );
  }

  async save(input: unknown) {
    const fields = managedConfigurationSaveInput.parse(input);
    const { workspaceId, configurationId, revision, requestId } = fields;
    const memberRevision = await authorize(
      this.context,
      workspaceId,
      CAPABILITY.SECRETS,
    );
    const existing = revision
      ? await this.row(workspaceId, configurationId)
      : null;
    const acceptedRetry = Boolean(
      existing &&
        existing.state === "active" &&
        existing.revision === revision + 1 &&
        existing.write_id === requestId &&
        existing.entry_kind === fields.configuration.entryKind,
    );
    if (
      existing &&
      (existing.state !== "active" ||
        (existing.revision !== revision && !acceptedRetry) ||
        existing.entry_kind !== fields.configuration.entryKind)
    )
      this.conflict();
    if (
      fields.configuration.entryKind === SECRET_ENTRY_KIND.VARIABLE &&
      !secretVariableMetadataSchema.shape.value.safeParse(
        fields.configuration.desiredValue,
      ).success
    )
      throw new DomainError(
        "secret_input_invalid",
        "The desired GitHub variable value exceeds the supported UTF-8 limit of " +
          GITHUB_SECRET_LIMITS.VALUE_BYTES +
          " bytes.",
        400,
      );
    const selected: SelectedManagedDestination[] = [];
    for (const item of fields.configuration.destinations)
      selected.push(
        await this.normalizeDestination(
          workspaceId,
          fields.configuration.entryKind,
          item,
        ),
      );
    const configuration: ManagedConfigurationFields = {
      ...fields.configuration,
      destinations: selected.map((item) => item.destination),
    };
    if (
      await this.conflicts(
        workspaceId,
        configurationId,
        SECRET_PROVIDER_KIND.GITHUB,
        configuration.entryKind,
        configuration.destinations,
      )
    )
      throw new DomainError(
        "managed_destination_conflict",
        "One of these provider entries is already owned by another managed configuration.",
        409,
      );
    await authorize(this.context, workspaceId, CAPABILITY.SECRETS);
    const guard = actorGuard(
      this.context,
      workspaceId,
      CAPABILITY.SECRETS,
      memberRevision,
    );
    const now = this.timestamp();
    const resultingRevision = revision + 1;
    const eventId =
      "managed_configuration_saved:" +
      workspaceId +
      ":" +
      configurationId +
      ":" +
      resultingRevision +
      ":" +
      requestId;
    const repositoryIds = [
      ...new Set(
        selected.flatMap((item) =>
          item.connection.resource.repositories.map(
            (repository) => repository.id,
          ),
        ),
      ),
    ];
    const scopeFields = (item: ManagedConfigurationDestination) => {
      const scope = item.destination.target.scope;
      return [
        scope.kind,
        scope.kind === "environment" || scope.kind === "organization"
          ? scope.name
          : "",
      ] as const;
    };
    const destinationGuardSql = selected
      .map(
        () => `AND EXISTS (SELECT 1 FROM secret_connections c,json_each(c.resources_json) resource
          WHERE c.workspace_id=? AND c.id=? AND c.revision=? AND c.enabled=1 AND c.provider_kind=?
            AND json_extract(resource.value,'$.id')=?)
        AND EXISTS (SELECT 1 FROM repositories r WHERE r.workspace_id=? AND r.id=?)`,
      )
      .join("\n");
    const destinationGuardValues = selected.flatMap((item) => [
      workspaceId,
      item.connection.row.id,
      item.connection.row.revision,
      item.connection.row.provider_kind,
      item.destination.destination.target.resourceId,
      workspaceId,
      item.destination.destination.target.resourceId,
    ]);
    try {
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO managed_configurations
          (workspace_id,id,label,entry_kind,custody,desired_value,state,revision,created_at,updated_at,write_id)
          SELECT ?,?,?,?,?,?,'active',1,?,?,? WHERE ${guard.sql}
          ${destinationGuardSql} AND
          ((?=0 AND NOT EXISTS (SELECT 1 FROM managed_configurations WHERE workspace_id=? AND id=?)
            AND (SELECT COUNT(*) FROM managed_configurations WHERE workspace_id=? AND state='active')<?)
          OR (? > 0 AND EXISTS (SELECT 1 FROM managed_configurations WHERE workspace_id=? AND id=? AND state='active' AND revision=?)))
          ON CONFLICT(workspace_id,id) DO UPDATE SET label=excluded.label,desired_value=excluded.desired_value,
            revision=?,updated_at=excluded.updated_at,write_id=excluded.write_id
          WHERE managed_configurations.state='active' AND managed_configurations.revision=?
            AND managed_configurations.entry_kind=excluded.entry_kind AND managed_configurations.write_id<>?
            AND ${this.activeOperationSql()}`,
          )
          .bind(
            workspaceId,
            configurationId,
            configuration.label,
            configuration.entryKind,
            configuration.custody,
            configuration.desiredValue,
            now,
            now,
            requestId,
            ...guard.values,
            ...destinationGuardValues,
            revision,
            workspaceId,
            configurationId,
            workspaceId,
            MANAGED_CONFIGURATION_LIMITS.CONFIGURATIONS,
            revision,
            workspaceId,
            configurationId,
            revision,
            resultingRevision,
            revision,
            requestId,
          ),
        this.db
          .prepare(
            `DELETE FROM managed_configuration_destinations WHERE workspace_id=? AND configuration_id=?
          AND EXISTS (SELECT 1 FROM managed_configurations WHERE workspace_id=? AND id=? AND revision=? AND write_id=?)
          AND NOT EXISTS (SELECT 1 FROM activity WHERE id=?)`,
          )
          .bind(
            workspaceId,
            configurationId,
            workspaceId,
            configurationId,
            resultingRevision,
            requestId,
            eventId,
          ),
        ...configuration.destinations.map((item, index) =>
          this.db
            .prepare(
              `INSERT INTO managed_configuration_destinations
            (workspace_id,configuration_id,destination_index,destination_key,entry_kind,provider_kind,connection_id,resource_id,scope_kind,scope_name,provider_name,desired_state)
            SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS
              (SELECT 1 FROM managed_configurations WHERE workspace_id=? AND id=? AND revision=? AND write_id=?)
              AND NOT EXISTS (SELECT 1 FROM activity WHERE id=?)`,
            )
            .bind(
              workspaceId,
              configurationId,
              index,
              managedDestinationKey(
                SECRET_PROVIDER_KIND.GITHUB,
                configuration.entryKind,
                item.destination,
              ),
              configuration.entryKind,
              SECRET_PROVIDER_KIND.GITHUB,
              item.destination.connectionId,
              item.destination.target.resourceId,
              ...scopeFields(item),
              item.destination.name,
              item.desiredState,
              workspaceId,
              configurationId,
              resultingRevision,
              requestId,
              eventId,
            ),
        ),
        this.db
          .prepare(
            `INSERT OR IGNORE INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,created_at)
          SELECT ?,?,?,?,'secrets.configuration.saved','Managed configuration saved',?,? WHERE EXISTS
            (SELECT 1 FROM managed_configurations WHERE workspace_id=? AND id=? AND revision=? AND write_id=?)`,
          )
          .bind(
            eventId,
            workspaceId,
            this.context.principal.subject,
            this.context.principal.displayName,
            "Saved HQ ownership and desired destinations for " +
              configuration.label +
              ". No provider configuration was changed.",
            now,
            workspaceId,
            configurationId,
            resultingRevision,
            requestId,
          ),
        this.db
          .prepare(
            `INSERT OR IGNORE INTO activity_repository_links (workspace_id,event_id,repository_id)
          SELECT ?,?,r.id FROM repositories r WHERE r.workspace_id=? AND r.id IN (SELECT value FROM json_each(?))
            AND EXISTS (SELECT 1 FROM activity WHERE workspace_id=? AND id=?)`,
          )
          .bind(
            workspaceId,
            eventId,
            workspaceId,
            JSON.stringify(repositoryIds),
            workspaceId,
            eventId,
          ),
      ]);
    } catch (error) {
      if (
        await this.conflicts(
          workspaceId,
          configurationId,
          SECRET_PROVIDER_KIND.GITHUB,
          configuration.entryKind,
          configuration.destinations,
        )
      )
        throw new DomainError(
          "managed_destination_conflict",
          "One of these provider entries was claimed by another managed configuration. Keep your draft and reload.",
          409,
        );
      throw error;
    }
    const saved = await this.row(workspaceId, configurationId).catch(
      () => null,
    );
    if (
      !saved ||
      saved.state !== "active" ||
      saved.revision !== resultingRevision ||
      saved.write_id !== requestId
    )
      this.conflict();
    const savedConfiguration = await this.configuration(
      workspaceId,
      configurationId,
    );
    const savedFields: ManagedConfigurationFields = {
      label: savedConfiguration.label,
      entryKind: savedConfiguration.entryKind,
      custody: savedConfiguration.custody,
      desiredValue: savedConfiguration.desiredValue,
      destinations: savedConfiguration.destinations,
    } as ManagedConfigurationFields;
    if (JSON.stringify(savedFields) !== JSON.stringify(configuration))
      this.conflict();
    return savedConfiguration;
  }

  async stop(input: unknown) {
    const { workspaceId, configurationId, revision, requestId } =
      managedConfigurationStopInput.parse(input);
    const memberRevision = await authorize(
      this.context,
      workspaceId,
      CAPABILITY.SECRETS,
    );
    const row = await this.row(workspaceId, configurationId);
    if (row.state === "stopped" && row.write_id === requestId)
      return { configurationId, stopped: true as const };
    if (row.state !== "active" || row.revision !== revision) this.conflict();
    const destinations = await this.destinationRows(workspaceId, [
      configurationId,
    ]);
    const repositoryIds = destinations.map((item) => item.resource_id);
    const guard = actorGuard(
      this.context,
      workspaceId,
      CAPABILITY.SECRETS,
      memberRevision,
    );
    const eventId =
      "managed_configuration_stopped:" +
      workspaceId +
      ":" +
      configurationId +
      ":" +
      (revision + 1) +
      ":" +
      requestId;
    const now = this.timestamp();
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE managed_configurations SET state='stopped',desired_value=NULL,revision=revision+1,updated_at=?,write_id=?
        WHERE workspace_id=? AND id=? AND state='active' AND revision=? AND ${guard.sql} AND ${this.activeOperationSql()}`,
        )
        .bind(
          now,
          requestId,
          workspaceId,
          configurationId,
          revision,
          ...guard.values,
        ),
      this.db
        .prepare(
          `DELETE FROM managed_configuration_destinations WHERE workspace_id=? AND configuration_id=?
        AND EXISTS (SELECT 1 FROM managed_configurations WHERE workspace_id=? AND id=? AND state='stopped' AND write_id=?)`,
        )
        .bind(
          workspaceId,
          configurationId,
          workspaceId,
          configurationId,
          requestId,
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO activity (id,workspace_id,actor_subject,actor_name,type,title,summary,created_at)
        SELECT ?,?,?,?,'secrets.configuration.stopped','Managed configuration stopped',?,? WHERE EXISTS
          (SELECT 1 FROM managed_configurations WHERE workspace_id=? AND id=? AND state='stopped' AND write_id=?)`,
        )
        .bind(
          eventId,
          workspaceId,
          this.context.principal.subject,
          this.context.principal.displayName,
          "Stopped HQ management for " +
            row.label +
            ". Provider configuration was left unchanged.",
          now,
          workspaceId,
          configurationId,
          requestId,
        ),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO activity_repository_links (workspace_id,event_id,repository_id)
        SELECT ?,?,r.id FROM repositories r WHERE r.workspace_id=? AND r.id IN (SELECT value FROM json_each(?))
          AND EXISTS (SELECT 1 FROM activity WHERE workspace_id=? AND id=?)`,
        )
        .bind(
          workspaceId,
          eventId,
          workspaceId,
          JSON.stringify(repositoryIds),
          workspaceId,
          eventId,
        ),
    ]);
    const stopped = await this.row(workspaceId, configurationId);
    if (stopped.state !== "stopped" || stopped.write_id !== requestId)
      this.conflict();
    return { configurationId, stopped: true as const };
  }

  async selected(
    workspaceId: string,
    configuration: ManagedConfiguration,
    destinationIndex: number,
  ) {
    const desired = configuration.destinations[destinationIndex];
    if (!desired) this.conflict();
    const selected = await this.normalizeDestination(
      workspaceId,
      configuration.entryKind,
      desired,
    );
    return { ...selected, desired };
  }

  async inspect(
    workspaceId: string,
    configuration: ManagedConfiguration,
    destinationIndex: number,
  ): Promise<{
    snapshot: ManagedProviderSnapshot;
    selected: SelectedManagedDestination;
  }> {
    const selected = await this.selected(
      workspaceId,
      configuration,
      destinationIndex,
    );
    const snapshot = await selected.connection.provider.inspectManaged!(
      selected.connection.resource,
      selected.destination.destination.target.scope,
      configuration.entryKind,
      selected.destination.destination.name,
    );
    await this.secrets.recheck(
      workspaceId,
      selected.connection.row,
      selected.connection.resource,
      selected.connection.provider.identity,
    );
    return { snapshot, selected };
  }

  observedItem(
    configurationId: string,
    snapshot: ManagedProviderSnapshot,
  ) {
    return snapshot.item
      ? {
          ...snapshot.item,
          management: SECRET_MANAGEMENT.HQ,
          managedConfigurationId: configurationId,
        }
      : null;
  }

  async status(input: unknown) {
    const { workspaceId, configurationId } =
      managedConfigurationInput.parse(input);
    await authorize(this.context, workspaceId);
    const configuration = await this.configuration(
      workspaceId,
      configurationId,
    );
    const observations = await Promise.all(
      configuration.destinations.map(
        async (
          _destination,
          destinationIndex,
        ): Promise<ManagedConfigurationObservation> => {
          try {
            const { snapshot } = await this.inspect(
              workspaceId,
              configuration,
              destinationIndex,
            );
            const item = this.observedItem(configuration.id, snapshot);
            return {
              destinationIndex,
              status: managedConfigurationStatus(
                configuration.entryKind,
                configuration.destinations[destinationIndex]!.desiredState,
                configuration.desiredValue,
                item,
              ),
              item,
              observedAt: snapshot.observedAt,
              error: null,
            };
          } catch (error) {
            return {
              destinationIndex,
              status: MANAGED_CONFIGURATION_STATUS.UNAVAILABLE,
              item: null,
              observedAt: this.timestamp(),
              error:
                error instanceof DomainError
                  ? { code: error.code, message: error.message }
                  : {
                      code: "unavailable",
                      message:
                        "Provider configuration could not be read. Unavailable state is not treated as absence.",
                    },
            };
          }
        },
      ),
    );
    await authorize(this.context, workspaceId);
    const current = await this.configuration(workspaceId, configurationId);
    if (JSON.stringify(current) !== JSON.stringify(configuration))
      this.conflict();
    return { configuration: current, observations };
  }
}
