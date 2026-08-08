import { SeedError } from "@seed-ae/domain";
import type { GenerationProvider, ProviderCapabilities } from "./types.js";

/**
 * Lookup for the providers this service is configured with. The router asks
 * the registry for a provider by id; nothing else knows which concrete adapter
 * is in play.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, GenerationProvider>();

  register(provider: GenerationProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  get(id: string): GenerationProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new SeedError("not_found", `unknown provider "${id}"`, {
        details: { available: this.ids() },
      });
    }
    return provider;
  }

  ids(): string[] {
    return [...this.providers.keys()];
  }

  list(): GenerationProvider[] {
    return [...this.providers.values()];
  }

  async describeAll(): Promise<ProviderCapabilities[]> {
    return Promise.all(this.list().map((provider) => provider.capabilities()));
  }
}
