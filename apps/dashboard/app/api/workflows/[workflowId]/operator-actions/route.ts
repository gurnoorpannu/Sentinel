import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ workflowId: string }> }) {
  const operatorToken = process.env.OPERATOR_TOKEN;
  if (!operatorToken) {
    return NextResponse.json(
      {
        error: {
          code: 'OPERATOR_CONTROLS_DISABLED',
          message: 'Operator controls are not configured',
        },
      },
      { status: 404 },
    );
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return invalidRequest();
  }
  if (typeof input !== 'object' || input === null || !('actor' in input)) {
    return invalidRequest();
  }
  const { actor, ...action } = input;
  if (typeof actor !== 'string') {
    return invalidRequest();
  }

  const { workflowId } = await context.params;
  const apiUrl =
    process.env.SENTINEL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  const target = new URL(`/workflows/${encodeURIComponent(workflowId)}/operator-actions`, apiUrl);

  try {
    const response = await fetch(target, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${operatorToken}`,
        'content-type': 'application/json',
        'x-operator-id': actor,
      },
      body: JSON.stringify(action),
    });
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

function invalidRequest() {
  return NextResponse.json(
    {
      error: {
        code: 'INVALID_OPERATOR_ACTION',
        message: 'A valid operator identity and action are required',
      },
    },
    { status: 400 },
  );
}
