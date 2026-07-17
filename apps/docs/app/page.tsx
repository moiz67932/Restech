const sections = [
  'Introduction',
  'Quick Start',
  'Authentication',
  'Request Signing',
  'Idempotency',
  'Environments',
  'Bills',
  'Payments',
  'Tables',
  'Webhooks',
  'Webhook Verification',
  'Error Codes',
  'Retries',
  'Sandbox',
  'Testing Scenarios',
  'API Versioning',
  'Rate Limits',
  'Support',
  'Changelog',
];
const languages = ['cURL', 'Node.js / TypeScript', 'Python', 'PHP', 'Java', 'C#', 'Go'];
export default function Docs() {
  return (
    <main>
      <header>
        <strong>Restec Developers</strong>
        <span style={{ float: 'right' }}>Sandbox | Production</span>
        <h1>Build restaurant integrations once</h1>
        <p>Use integer minor units and sign the exact raw request bytes.</p>
      </header>
      <nav>
        {sections.map((s) => (
          <a key={s} href={`#${s.toLowerCase().replaceAll(' ', '-')}`} style={{ marginRight: 12 }}>
            {s}
          </a>
        ))}
      </nav>
      <section>
        <h2>Quick Start</h2>
        <p>
          Send requests to sandbox-api.restec.io with an rst_test_ API key. Every signed request
          includes the timestamp, method, path, and exact body bytes.
        </p>
        <label>
          Language{' '}
          <select>
            {languages.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
        <pre>
          <code>{`curl -X GET https://sandbox-api.restec.io/v1/locations/loc_example/tables \\\n  -H "Authorization: Bearer rst_test_example" \\\n  -H "X-Restec-Timestamp: 1784260800" \\\n  -H "X-Restec-Signature: v1=<computed-hmac>" \\\n  -H "X-Request-Id: req_example"`}</code>
        </pre>
      </section>
      {sections.slice(2).map((s) => (
        <section id={s.toLowerCase().replaceAll(' ', '-')} key={s}>
          <h2>{s}</h2>
          <p>See the Restec POS API reference and copyable examples for this topic.</p>
        </section>
      ))}
    </main>
  );
}
