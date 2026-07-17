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
        <p>Signed in as Developer</p>
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
          <button>Create key</button> <button>Rotate</button> <button>Revoke</button>
          <p>New secrets are displayed once. Stored secrets cannot be viewed again.</p>
        </div>
        <div>
          <h2>Webhook Endpoint</h2>
          <input
            aria-label="HTTPS webhook URL"
            placeholder="https://partner.example/webhooks/restec"
            style={{ width: 420 }}
          />{' '}
          <button>Save</button> <button>Send test event</button>
        </div>
        <div>
          <h2>Sandbox Simulator</h2>
          <button>Partial payment</button> <button>Full payment</button> <button>Failure</button>{' '}
          <button>Refund</button> <button>Duplicate webhook</button>{' '}
          <button>Delayed webhook</button> <button>POS timeout</button>{' '}
          <button>Out-of-order event</button>
        </div>
      </section>
    </main>
  );
}
