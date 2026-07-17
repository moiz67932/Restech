import type { PosConnector } from '@restec/connector-sdk';
import { canonicalRestConnector } from '@restec/connector-canonical-rest';
import { mockPosConnector } from '@restec/connector-mock-pos';
const connectors = new Map([
  [canonicalRestConnector.id, canonicalRestConnector],
  [mockPosConnector.id, mockPosConnector],
]);
export class ConnectorRegistry {
  resolve(type: string, version: string, enabled = true): PosConnector {
    if (!enabled) throw new Error('Connector is disabled');
    const connector = connectors.get(type);
    if (!connector) throw new Error('Unknown connector');
    if (connector.version !== version) throw new Error('Connector version mismatch');
    return connector;
  }
}
