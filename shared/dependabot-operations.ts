import { z } from "zod";
import { DEPENDABOT_PATHS } from "./dependabot";
import {
  dependencyOperationInput,
  dependencyOperationsInput,
  dependencyOperationSchema,
} from "./dependency-operations";

export const dependabotOperationInput = dependencyOperationInput;
export const dependabotOperationsInput = dependencyOperationsInput;
export const dependabotOperationSchema = dependencyOperationSchema
  .extend({
    files: z
      .array(
        dependencyOperationSchema.shape.files.element
          .extend({ path: z.enum(DEPENDABOT_PATHS) })
          .strict(),
      )
      .max(1),
  })
  .strict();
export type DependabotOperation = z.infer<typeof dependabotOperationSchema>;
