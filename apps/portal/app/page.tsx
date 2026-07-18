const screens = [
  'Overview',
  'API Keys',
  'Webhook Endpoint',
  'Webhook Deliveries',
  'Locations',
  'Table Mappings',
  'Connector Configuration',
  'Sandbox Simulator',
  'Audit Activity',
  'Documentation',
];
export default function Portal() {
  return (
    <main style={{ display: 'grid', gridTemplateColumns: '240px 1fr', minHeight: '100vh' }}>
      <aside style={{ padding: 24, background: '#10251f', color: 'white' }}>
        <h2>Restec Portal</h2>
        <p>Admin access not configured</p>
        {screens.map((s) => (
          <button
            key={s}
            style={{
              display: 'block',
              width: '100%',
              margin: '8px 0',
              padding: 10,
              textAlign: 'left',
            }}
          >
            {s}
          </button>
        ))}
      </aside>
      <section style={{ padding: 40 }}>
        <h1>Overview</h1>
        <p>Manage integrations, credentials, delivery health, and sandbox tests.</p>
        <div>
          <h2>API Keys</h2>
          <button disabled title="Requires the protected admin service">
            Create key
          </button>{' '}
          <button disabled title="Requires the protected admin service">
            Rotate
          </button>{' '}
          <button disabled title="Requires the protected admin service">
            Revoke
          </button>
          <p>New secrets are displayed once. Stored secrets cannot be viewed again.</p>
        </div>
        <div>
          <h2>Webhook Endpoint</h2>
          <input
            aria-label="HTTPS webhook URL"
            placeholder="https://partner.example/webhooks/restec"
            style={{ width: 420 }}
          />{' '}
          <button disabled>Save</button> <button disabled>Send sandbox test event</button>
        </div>
        <div>
          <h2>Sandbox Simulator</h2>
          <p>Controls remain disabled until authenticated sandbox admin wiring is configured.</p>
          <button disabled>Partial payment</button> <button disabled>Full payment</button>{' '}
          <button disabled>Failure</button> <button disabled>Refund</button>{' '}
          <button disabled>Duplicate webhook</button> <button disabled>Delayed webhook</button>{' '}
          <button disabled>POS timeout</button> <button disabled>Out-of-order event</button>
        </div>
      </section>
    </main>
  );
}
