const READINESS_TIMEOUT_MS = 30_000;
const DIAGNOSTIC_LIMITS = Object.freeze({ events: 20, text: 600 });

export async function captureCoverPage(page, { origin, projects, timeoutMs = READINESS_TIMEOUT_MS }) {
  const started = performance.now();
  const events = [];
  let omittedEvents = 0;
  let stage = "navigation";
  let browserError;
  let rejectBrowserFailure;
  const browserFailure = new Promise((_, reject) => { rejectBrowserFailure = reject; });
  void browserFailure.catch(() => {});
  const safeUrl = value => {
    try {
      const url = new URL(value);
      return url.origin === origin ? url.pathname : "[external URL]";
    } catch {
      return "[unknown URL]";
    }
  };
  const bounded = value => String(value)
    .replace(/https?:\/\/[^\s"'<>]+/g, safeUrl)
    .slice(0, DIAGNOSTIC_LIMITS.text);
  const record = event => {
    if (events.length < DIAGNOSTIC_LIMITS.events) events.push(event);
    else omittedEvents++;
  };
  const failBrowser = message => {
    browserError ??= new Error(bounded(message));
    rejectBrowserFailure(browserError);
  };
  const listeners = {
    pageerror: error => {
      record({ type: "pageerror", message: bounded(error.message) });
      failBrowser(error.message);
    },
    crash: () => {
      record({ type: "crash" });
      failBrowser("Browser page crashed");
    },
    console: message => {
      if (message.type() === "error") record({ type: "console", message: bounded(message.text()) });
    },
    response: response => {
      if (response.status() >= 400) record({ type: "response", path: bounded(safeUrl(response.url())), status: response.status() });
    },
    requestfailed: request => record({
      type: "requestfailed", path: bounded(safeUrl(request.url())),
      error: bounded(request.failure()?.errorText ?? "Unknown network failure"),
    }),
  };
  for (const [event, listener] of Object.entries(listeners)) page.on(event, listener);
  const run = async (name, operation) => {
    stage = name;
    if (browserError) throw browserError;
    let timer;
    try {
      return await Promise.race([
        operation(), browserFailure,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Readiness deadline exceeded (${timeoutMs}ms)`)), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await page.route(/^https?:/, route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await run("navigation", async () => {
      const response = await page.goto(`${origin}/projects?workspace=development`, { timeout: timeoutMs });
      if (!response?.ok()) throw new Error(`Projects navigation returned HTTP ${response?.status() ?? "unknown"}`);
    });
    for (const [name] of projects) {
      await run(`project link: ${name}`, () => page.getByRole("link", { name, exact: true }).waitFor({ timeout: timeoutMs }));
    }
    await run("live updates", () => page.getByText("Live updates", { exact: true }).waitFor({ timeout: timeoutMs }));
    await run("fonts", () => page.evaluate(() => document.fonts.ready));
    return await run("screenshot", async () => {
      await page.mouse.move(1439, 999);
      return page.screenshot({ animations: "disabled", timeout: timeoutMs });
    });
  } catch (error) {
    const diagnostic = {
      stage, elapsedMs: Math.round(performance.now() - started),
      page: bounded(safeUrl(page.url())), error: bounded(error.message ?? error), events, omittedEvents,
    };
    throw new Error(`Cover capture failed: ${JSON.stringify(diagnostic)}`);
  } finally {
    for (const [event, listener] of Object.entries(listeners)) page.off(event, listener);
  }
}
