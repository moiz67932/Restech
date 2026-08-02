import { publicFile } from '../../lib/content';
import { NextResponse } from 'next/server';
const files: Record<string, [string, string]> = {
  'restec-postman-collection.json': [
    'postman/Restec-POS-Partner-v1.postman_collection.json',
    'application/json',
  ],
  'restec-postman-sandbox.json': [
    'postman/Restec-POS-Partner-Sandbox.postman_environment.json',
    'application/json',
  ],
  'restec-pos-partner-v1.yaml': ['openapi/restec-pos-partner-v1.yaml', 'text/yaml'],
  'restec-curl.sh': ['examples/curl/restec.sh', 'text/plain'],
  'restec-node.mjs': ['examples/node/restec-client.mjs', 'text/plain'],
  'restec-csharp.cs': ['examples/csharp/Program.cs', 'text/plain'],
  'restec-java.java': ['examples/java/RestecPartnerExample.java', 'text/plain'],
};
export async function GET(_: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const spec = files[name];
  if (!spec) return new NextResponse('Not found', { status: 404 });
  return new NextResponse(publicFile(spec[0]) as BodyInit, {
    headers: {
      'Content-Type': spec[1],
      'Content-Disposition': 'attachment; filename="' + name + '"',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
