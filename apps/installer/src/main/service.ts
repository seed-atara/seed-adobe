/**
 * Running the SEED service, and knowing whether it is actually up.
 *
 * The service is plain JavaScript on Node. Electron 42 carries Node 24.18.1
 * and — the fact this whole design rests on — `node:sqlite` with it, so there
 * is no vendored runtime, no native module, and no ABI to keep in step. The
 * bundled service is forked with `ELECTRON_RUN_AS_NODE`, which is the same
 * binary already on disk behaving as a plain Node process.
 *
 * "Is it up" is answered by asking it, not by whether the child is alive. A
 * process that started and then failed to bind a port is exactly the state
 * that looks fine from the outside and is broken from the panel's.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

export type ServiceState = "stopped" | "starting" | "running" | "failed";

export interface ServiceOptions {
  /** Absolute path to the bundled service entry point. */
  entry: string;
  /** Where the asset library and database live. */
  workspace: string;
  /** The token the panel was given. */
  token: string;
  port: number;
  /** Where panel-set credentials are read from and written to. */
  credentialsPath: string;
  /** The bundled ffmpeg, when this build carries one. */
  ffmpeg?: string;
}

export declare interface ServiceSupervisor {
  on(event: "state", listener: (state: ServiceState, detail?: string) => void): this;
  on(event: "log", listener: (line: string) => void): this;
}

export class ServiceSupervisor extends EventEmitter {
  private child?: ChildProcess;
  private state: ServiceState = "stopped";
  private detail = "";
  private stopping = false;
  private poll?: NodeJS.Timeout;
  /** Kept so the status window can show what the service last said. */
  private readonly recent: string[] = [];

  constructor(private readonly options: ServiceOptions) {
    super();
  }

  get currentState(): ServiceState {
    return this.state;
  }

  get lastDetail(): string {
    return this.detail;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.options.port}`;
  }

  /** The last few lines the service wrote, newest last. */
  recentLog(): string[] {
    return [...this.recent];
  }

  start(): void {
    if (this.child) return;
    this.stopping = false;
    this.setState("starting");

    this.child = spawn(process.execPath, [this.options.entry], {
      env: {
        ...process.env,
        // Makes the Electron binary behave as plain Node for this child.
        ELECTRON_RUN_AS_NODE: "1",
        SEED_AE_HOST: "127.0.0.1",
        SEED_AE_PORT: String(this.options.port),
        SEED_AE_SESSION_TOKEN: this.options.token,
        SEED_AE_WORKSPACE: this.options.workspace,
        SEED_AE_CREDENTIALS: this.options.credentialsPath,
        ...(this.options.ffmpeg ? { SEED_FFMPEG: this.options.ffmpeg } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const record = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.recent.push(line);
        // Enough to diagnose a failed start, not enough to hold a session's
        // worth of request logs in memory.
        if (this.recent.length > 200) this.recent.shift();
        this.emit("log", line);
      }
    };
    this.child.stdout?.on("data", record);
    this.child.stderr?.on("data", record);

    this.child.on("exit", (code, signal) => {
      this.child = undefined;
      this.stopPolling();
      if (this.stopping) {
        this.setState("stopped");
        return;
      }
      this.setState(
        "failed",
        signal ? `the service was stopped (${signal})` : `the service exited with code ${code}`,
      );
    });

    this.child.on("error", (error) => {
      this.child = undefined;
      this.stopPolling();
      this.setState("failed", error.message);
    });

    this.startPolling();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopPolling();
    const child = this.child;
    if (!child) {
      this.setState("stopped");
      return;
    }
    await new Promise<void>((resolve) => {
      const done = setTimeout(() => {
        // SIGTERM is handled by the service, which closes the database before
        // exiting. Only escalate if it does not take the hint.
        child.kill("SIGKILL");
        resolve();
      }, 4000);
      child.once("exit", () => {
        clearTimeout(done);
        resolve();
      });
      child.kill("SIGTERM");
    });
    this.child = undefined;
    this.setState("stopped");
  }

  async restart(): Promise<void> {
    await this.stop();
    this.start();
  }

  /**
   * Asks `/health` rather than trusting the process table.
   *
   * `/health` is the one route that needs no token, which is what makes it
   * usable as a liveness check from here.
   */
  private startPolling(): void {
    this.stopPolling();
    const tick = async () => {
      try {
        const response = await fetch(`${this.baseUrl}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) {
          this.setState("running");
          return;
        }
        this.setState("starting", `the service answered ${response.status}`);
      } catch {
        // Not up yet, or gone. The exit handler distinguishes the two; while
        // the child is alive this is simply "still starting".
        if (this.child) this.setState("starting");
      }
    };
    void tick();
    this.poll = setInterval(() => void tick(), 1500);
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }

  private setState(state: ServiceState, detail = ""): void {
    if (this.state === state && this.detail === detail) return;
    this.state = state;
    this.detail = detail;
    this.emit("state", state, detail);
  }
}
