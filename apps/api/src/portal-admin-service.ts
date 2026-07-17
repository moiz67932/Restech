export interface PortalActor {
  partnerId: string;
  role: 'owner' | 'admin' | 'developer' | 'viewer';
}
export interface PortalAdminService {
  listApiKeys(actor: PortalActor): Promise<unknown[]>;
  createApiKey(actor: PortalActor, environment: 'sandbox' | 'production'): Promise<unknown>;
  revokeApiKey(actor: PortalActor, id: string): Promise<void>;
  rotateApiKey(actor: PortalActor, id: string): Promise<unknown>;
  configureWebhook(actor: PortalActor, input: unknown): Promise<unknown>;
  rotateWebhookSecret(actor: PortalActor, id: string): Promise<unknown>;
  listLocations(actor: PortalActor): Promise<unknown[]>;
  listTableMappings(actor: PortalActor): Promise<unknown[]>;
  listDeliveries(actor: PortalActor): Promise<unknown[]>;
  replayEvent(actor: PortalActor, id: string): Promise<void>;
  listAuditActivity(actor: PortalActor): Promise<unknown[]>;
  runSandboxScenario(actor: PortalActor, input: unknown): Promise<unknown>;
}
export class DisabledPortalAdminService implements PortalAdminService {
  private unavailable(): never {
    throw new Error('Portal mutations are disabled pending identity-provider approval.');
  }
  async listApiKeys() {
    return this.unavailable();
  }
  async createApiKey() {
    return this.unavailable();
  }
  async revokeApiKey() {
    return this.unavailable();
  }
  async rotateApiKey() {
    return this.unavailable();
  }
  async configureWebhook() {
    return this.unavailable();
  }
  async rotateWebhookSecret() {
    return this.unavailable();
  }
  async listLocations() {
    return this.unavailable();
  }
  async listTableMappings() {
    return this.unavailable();
  }
  async listDeliveries() {
    return this.unavailable();
  }
  async replayEvent() {
    return this.unavailable();
  }
  async listAuditActivity() {
    return this.unavailable();
  }
  async runSandboxScenario() {
    return this.unavailable();
  }
}
