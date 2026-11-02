import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { API_VERSION } from '../common/util';

/** OPENAPI=on|off; default on outside production. The document lists routes only, no secrets. */
export const openApiEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.OPENAPI ? env.OPENAPI !== 'off' : env.NODE_ENV !== 'production';

/** Generated from the controllers: Swagger UI at /docs, the JSON document at /docs/openapi.json. */
export function setupOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('JP Orchestrator API')
    .setDescription('Contrato completo (papéis, tipos, eventos SSE e webhooks) em docs/api-contract.md.')
    .setVersion(API_VERSION)
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-API-Key' }, 'apiKey')
    .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'bearer')
    .addSecurityRequirements('apiKey')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/openapi.json', yamlDocumentUrl: 'docs/openapi.yaml' });
  return document;
}
