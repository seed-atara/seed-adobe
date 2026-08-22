import { SeedError, type JobStatus } from "@seed-ae/domain";

/**
 * fal's queue, in one place.
 *
 * Two providers here run against it — IC-Light for relighting and Luma Reframe
 * for aspect expansion — and they will not be the last. The submit-then-poll
 * dance, the "Key" authorisation scheme rather than "Bearer", and the
 * vocabulary its statuses use are all properties of *fal*, not of either
 * model, so they live here rather than being copied.
 */

export interface FalConfig {
  apiKey: string;
  /** Overridable so a fork or a self-host can be pointed at. */
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface FalSubmission {
  requestId: string;
  /** Absolute URLs fal hands back; the documented way to poll. */
  statusUrl?: string;
  responseUrl?: string;
}

interface QueueSubmissionPayload {
  request_id?: string;
  status_url?: string;
  response_url?: string;
  detail?: string;
}

interface QueueStatusPayload {
  status?: string;
  queue_position?: number;
  detail?: string;
}

/** fal's queue vocabulary, mapped onto SEED's. */
export function mapFalStatus(status?: string): JobStatus {
  switch (status) {
    case "COMPLETED":
      return "succeeded";
    case "IN_QUEUE":
      return "queued";
    case "IN_PROGRESS":
      return "running";
    default:
      /*
       * An unrecognised status is treated as still going rather than failed.
       * The poll will ask again, and guessing "failed" would abandon a job
       * that is merely in a state this adapter has not seen.
       */
      return "running";
  }
}

export class FalQueue {
  private readonly fetchImpl: typeof fetch;
  /** request_id -> where to ask about it, when fal told us. */
  private readonly urls = new Map<string, { status: string; response: string }>();

  constructor(private readonly config: FalConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  get base(): string {
    return (this.config.baseUrl ?? "https://queue.fal.run").replace(/\/+$/, "");
  }

  async submit(
    model: string,
    body: unknown,
    label: string,
  ): Promise<FalSubmission> {
    const response = await this.call("POST", `${this.base}/${model}`, body);
    const payload = (await response.json().catch(() => undefined)) as
      | QueueSubmissionPayload
      | undefined;

    if (!response.ok || !payload?.request_id) {
      throw new SeedError(
        "provider_error",
        `${label} returned HTTP ${response.status}` +
          (payload?.detail ? `: ${payload.detail}` : ""),
      );
    }

    if (payload.status_url && payload.response_url) {
      this.urls.set(payload.request_id, {
        status: payload.status_url,
        response: payload.response_url,
      });
    }

    return {
      requestId: payload.request_id,
      ...(payload.status_url ? { statusUrl: payload.status_url } : {}),
      ...(payload.response_url ? { responseUrl: payload.response_url } : {}),
    };
  }

  /** Where the job is, and its result once it is done. */
  async poll<T>(
    model: string,
    requestId: string,
    label: string,
  ): Promise<{ status: JobStatus; result?: T; raw: unknown }> {
    const known = this.urls.get(requestId);
    /*
     * Rebuilt from the model path when the absolute URLs were not kept — after
     * a service restart, for instance, when the map is empty but the job is
     * still out there.
     */
    const statusUrl = known?.status ?? `${this.base}/${model}/requests/${requestId}/status`;

    const response = await this.call("GET", statusUrl);
    const status = (await response.json().catch(() => undefined)) as
      | QueueStatusPayload
      | undefined;

    if (!response.ok) {
      throw new SeedError(
        "provider_error",
        `${label} status returned HTTP ${response.status}` +
          (status?.detail ? `: ${status.detail}` : ""),
      );
    }

    const mapped = mapFalStatus(status?.status);
    if (mapped !== "succeeded") return { status: mapped, raw: status };

    const resultUrl = known?.response ?? `${this.base}/${model}/requests/${requestId}`;
    const resultResponse = await this.call("GET", resultUrl);
    const result = (await resultResponse.json().catch(() => undefined)) as T | undefined;

    if (!resultResponse.ok) {
      throw new SeedError(
        "provider_error",
        `${label} result returned HTTP ${resultResponse.status}`,
      );
    }

    return { status: "succeeded", ...(result ? { result } : {}), raw: result };
  }

  async cancel(model: string, requestId: string, label: string): Promise<void> {
    const response = await this.call(
      "PUT",
      `${this.base}/${model}/requests/${requestId}/cancel`,
    );
    /*
     * A job already running cannot be stopped, and that is not worth throwing
     * over: the caller wanted it gone and it will be shortly.
     */
    if (!response.ok && response.status !== 400 && response.status !== 409) {
      throw new SeedError(
        "provider_error",
        `could not cancel the ${label} request (HTTP ${response.status})`,
      );
    }
  }

  private call(method: string, url: string, body?: unknown): Promise<Response> {
    return this.fetchImpl(url, {
      method,
      headers: {
        // fal's scheme is "Key", not "Bearer". Silent, and easy to get wrong.
        authorization: `Key ${this.config.apiKey}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 120_000),
    });
  }
}
