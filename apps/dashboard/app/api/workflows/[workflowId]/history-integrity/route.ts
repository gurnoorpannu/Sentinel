import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = await context.params;
  const apiUrl =
    process.env.SENTINEL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  const target = new URL(`/workflows/${encodeURIComponent(workflowId)}/history-integrity`, apiUrl);

  try {
    const response = await fetch(target, { cache: 'no-store' });
    const body = await response.text();
    return new NextResponse(body, {
      status: response.status,
      headers: {
        'content-type': response.headers.get('content-type') ?? 'application/json',
      },
    });
  } catch {
    return NextResponse.json(
      {
        error: {
          code: 'SENTINEL_API_UNAVAILABLE',
          message: 'Sentinel API is unavailable',
        },
      },
      { status: 502 },
    );
  }
}
