import type { Reporter, TestCase, TestModule, TestSpecification, Vitest } from "vitest/node";

/** File-level progress and a heartbeat also cover slow imports and hooks. */
export default class RuntimeTestProgress implements Reporter {
  private context?: Vitest;
  private timer?: ReturnType<typeof setInterval>;
  private started = 0;
  private total = 0;
  private completed = 0;
  private readonly active = new Map<string, number>();
  private readonly cases = new Map<TestCase, number>();

  onInit(context: Vitest): void { this.context = context; }

  onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void {
    this.stop();
    this.started = Date.now();
    this.total = specifications.length;
    this.completed = 0;
    this.active.clear();
    this.cases.clear();
    this.report();
    this.timer = setInterval(() => this.report(), 15_000);
    this.timer.unref();
  }

  onTestModuleQueued(module: TestModule): void {
    this.active.set(module.relativeModuleId, Date.now());
  }

  onTestModuleEnd(module: TestModule): void {
    this.active.delete(module.relativeModuleId);
    this.completed++;
  }

  onTestCaseReady(test: TestCase): void { this.cases.set(test, Date.now()); }
  onTestCaseResult(test: TestCase): void { this.cases.delete(test); }

  onTestRunEnd(): void { this.stop(); this.report(); }
  onProcessTimeout(): void { this.stop(); }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private report(): void {
    const now = Date.now();
    const active = [...this.active].map(([file, started]) => {
      const cases = [...this.cases].filter(([test]) => test.module.relativeModuleId === file)
        .map(([test, began]) => `\n    ${test.fullName} (${Math.round((now - began) / 1000)}s)`);
      return `${file} (${Math.round((now - started) / 1000)}s)${cases.join("")}`;
    });
    this.context?.logger.log(
      `[agent-runtime] ${this.completed}/${this.total} files finished, ${Math.round((now - this.started) / 1000)}s elapsed` +
      (active.length ? `\n  ${active.join("\n  ")}` : ""),
    );
  }
}
