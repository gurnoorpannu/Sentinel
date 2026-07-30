export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Sentinel API',
    version: '0.1.0',
    description:
      'Control-plane API for durable PostgreSQL-backed workflows, history verification, metrics, and guarded operator recovery.',
  },
  servers: [{ url: 'http://localhost:4000', description: 'Local Docker Compose' }],
  tags: [
    { name: 'System', description: 'Process and dependency health' },
    { name: 'Workflows', description: 'Workflow creation and inspection' },
    { name: 'Operations', description: 'Protected metrics and operator recovery' },
  ],
  paths: {
    '/live': {
      get: {
        tags: ['System'],
        summary: 'Check process liveness',
        responses: {
          '200': {
            description: 'The API process can serve requests',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Probe' } } },
          },
        },
      },
    },
    '/ready': {
      get: {
        tags: ['System'],
        summary: 'Check database and schema readiness',
        responses: {
          '200': { description: 'PostgreSQL and all required migrations are ready' },
          '503': { description: 'The instance must not receive traffic' },
        },
      },
    },
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Check legacy database health',
        responses: {
          '200': { description: 'PostgreSQL is reachable' },
          '503': { description: 'PostgreSQL is unavailable' },
        },
      },
    },
    '/workflows': {
      get: {
        tags: ['Workflows'],
        summary: 'List recent workflow projections',
        parameters: [
          {
            name: 'status',
            in: 'query',
            schema: { $ref: '#/components/schemas/WorkflowStatus' },
          },
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          },
        ],
        responses: {
          '200': { description: 'Recent workflows and task counts' },
          '400': { $ref: '#/components/responses/BadRequest' },
        },
      },
      post: {
        tags: ['Workflows'],
        summary: 'Create a custom ordered workflow',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateWorkflow' } },
          },
        },
        responses: {
          '201': {
            description: 'The workflow and all ordered tasks were committed atomically',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/WorkflowDetail' } },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
        },
      },
    },
    '/workflows/ecommerce': {
      post: {
        tags: ['Workflows'],
        summary: 'Create the four-step e-commerce demonstration workflow',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/EcommerceWorkflow' } },
          },
        },
        responses: {
          '201': {
            description: 'The demonstration workflow was created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/WorkflowDetail' } },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
        },
      },
    },
    '/workflows/ecommerce/chaos': {
      post: {
        tags: ['Workflows'],
        summary: 'Create a deterministic failure-injected workflow',
        description: 'Registered only when CHAOS_MODE_ENABLED=true.',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ChaosWorkflow' } },
          },
        },
        responses: {
          '201': { description: 'The failure-injected workflow was created' },
          '400': { $ref: '#/components/responses/BadRequest' },
          '404': { description: 'Chaos mode is disabled' },
        },
      },
    },
    '/workflows/{workflowId}': {
      get: {
        tags: ['Workflows'],
        summary: 'Get a workflow projection, ordered tasks, and event history',
        parameters: [{ $ref: '#/components/parameters/WorkflowId' }],
        responses: {
          '200': {
            description: 'The complete durable workflow view',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/WorkflowDetail' } },
            },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/workflows/{workflowId}/history-integrity': {
      get: {
        tags: ['Workflows'],
        summary: 'Replay event history and compare it with the live projection',
        parameters: [{ $ref: '#/components/parameters/WorkflowId' }],
        responses: {
          '200': {
            description: 'Event replay integrity report',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/HistoryReport' } },
            },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/workflows/{workflowId}/operator-actions': {
      post: {
        tags: ['Operations'],
        summary: 'Apply a guarded cancel or recovery command',
        description:
          'Registered only when OPERATOR_TOKEN is configured. Requires X-Operator-ID for audit attribution.',
        security: [{ operatorBearer: [] }],
        parameters: [
          { $ref: '#/components/parameters/WorkflowId' },
          {
            name: 'X-Operator-ID',
            in: 'header',
            required: true,
            schema: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,119}$' },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/OperatorAction' } },
          },
        },
        responses: {
          '200': {
            description: 'The command and audit records committed atomically',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/WorkflowDetail' } },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { description: 'The operator bearer token is invalid' },
          '404': { $ref: '#/components/responses/NotFound' },
          '409': { description: 'The expected version or workflow state is stale' },
        },
      },
    },
    '/metrics': {
      get: {
        tags: ['Operations'],
        summary: 'Scrape Prometheus workflow, queue, and fleet metrics',
        description: 'Registered only when METRICS_TOKEN is configured.',
        security: [{ metricsBearer: [] }],
        responses: {
          '200': {
            description: 'Prometheus text exposition',
            content: { 'text/plain': { schema: { type: 'string' } } },
          },
          '401': { description: 'The metrics bearer token is invalid' },
          '404': { description: 'Metrics are disabled' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      metricsBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque token' },
      operatorBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque token' },
    },
    parameters: {
      WorkflowId: {
        name: 'workflowId',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
    },
    responses: {
      BadRequest: {
        description: 'Request validation failed',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      NotFound: {
        description: 'The workflow does not exist',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
    schemas: {
      Probe: {
        type: 'object',
        required: ['status', 'timestamp'],
        properties: {
          status: { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
      WorkflowStatus: {
        type: 'string',
        enum: [
          'pending',
          'running',
          'compensating',
          'completed',
          'failed',
          'compensated',
          'compensation_failed',
          'canceled',
        ],
      },
      TaskStatus: {
        type: 'string',
        enum: [
          'blocked',
          'ready',
          'leased',
          'retry_scheduled',
          'completed',
          'failed',
          'compensating',
          'compensated',
          'compensation_failed',
          'canceled',
        ],
      },
      WorkflowStep: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 },
          handler: { type: 'string' },
          compensationHandler: { type: 'string' },
          payload: { type: 'object', additionalProperties: true },
          maxAttempts: { type: 'integer', minimum: 1, maximum: 100, default: 5 },
        },
      },
      CreateWorkflow: {
        type: 'object',
        required: ['name', 'steps'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 },
          payload: { type: 'object', additionalProperties: true },
          steps: {
            type: 'array',
            minItems: 1,
            maxItems: 50,
            items: { $ref: '#/components/schemas/WorkflowStep' },
          },
        },
      },
      EcommerceWorkflow: {
        type: 'object',
        required: ['orderId', 'customerEmail', 'totalCents', 'items'],
        properties: {
          orderId: { type: 'string', minLength: 1, maxLength: 120 },
          customerEmail: { type: 'string', format: 'email' },
          totalCents: { type: 'integer', minimum: 1 },
          currency: { type: 'string', minLength: 3, maxLength: 3, default: 'USD' },
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: {
              type: 'object',
              required: ['sku', 'quantity'],
              properties: {
                sku: { type: 'string' },
                quantity: { type: 'integer', minimum: 1 },
              },
            },
          },
        },
      },
      ChaosWorkflow: {
        allOf: [
          { $ref: '#/components/schemas/EcommerceWorkflow' },
          {
            type: 'object',
            required: ['failure'],
            properties: {
              failure: {
                type: 'object',
                required: ['target', 'mode'],
                properties: {
                  target: {
                    type: 'string',
                    enum: ['charge-payment', 'reserve-inventory', 'send-confirmation'],
                  },
                  mode: {
                    type: 'string',
                    enum: [
                      'retryable',
                      'permanent',
                      'hang',
                      'crash_before_effect',
                      'crash_after_effect',
                    ],
                  },
                  attempts: { type: 'integer', minimum: 1, maximum: 10, default: 1 },
                  maxAttempts: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
                  delayMs: { type: 'integer', minimum: 0, maximum: 300000 },
                },
              },
            },
          },
        ],
      },
      OperatorAction: {
        type: 'object',
        required: ['action', 'reason', 'expectedVersion'],
        properties: {
          action: {
            type: 'string',
            enum: ['cancel', 'retry_failed_task', 'retry_compensation'],
          },
          reason: { type: 'string', minLength: 8, maxLength: 500 },
          expectedVersion: { type: 'integer', minimum: 1 },
        },
      },
      WorkflowDetail: {
        type: 'object',
        required: ['workflow', 'tasks', 'events'],
        properties: {
          workflow: { type: 'object', additionalProperties: true },
          tasks: { type: 'array', items: { type: 'object', additionalProperties: true } },
          events: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      HistoryReport: {
        type: 'object',
        required: ['workflowId', 'valid', 'eventCount', 'latestSequence', 'issues'],
        properties: {
          workflowId: { type: 'string', format: 'uuid' },
          valid: { type: 'boolean' },
          eventCount: { type: 'integer', minimum: 0 },
          latestSequence: { type: 'integer', minimum: 0 },
          replayedWorkflowStatus: { $ref: '#/components/schemas/WorkflowStatus' },
          issues: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
  },
} as const;
