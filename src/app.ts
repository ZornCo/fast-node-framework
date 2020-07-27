import * as fs from 'fs';
import * as path from 'path';
import fastify, {
  FastifyInstance,
  RouteHandlerMethod as IRouteHandlerMethod,
  RawServerBase,
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  ContextConfigDefault,
  FastifyRequest,
  FastifyReply
} from 'fastify';
import { RouteGenericInterface } from 'fastify/types/route';
import { MongoClient } from 'mongodb';
import { v4 } from 'uuid';

const ROUTE_DIR = path.join('dist', 'routes');
const DB_NAME = 'cgn';
// const MODULE_NAME = process.env.npm_package_name;

declare module "fastify" {
  interface FastifyInstance {
    db: MongoClient;
  }

  interface RouteHandlerMethod<
    RawServer extends RawServerBase = RawServerDefault,
    RawRequest extends RawRequestDefaultExpression<RawServer> = RawRequestDefaultExpression<RawServer>,
    RawReply extends RawReplyDefaultExpression<RawServer> = RawReplyDefaultExpression<RawServer>,
    RouteGeneric extends RouteGenericInterface = RouteGenericInterface,
    ContextConfig = ContextConfigDefault
  > extends Function {
    (
      this: FastifyInstance<RawServer, RawRequest, RawReply>,
      request: FastifyRequest<RouteGeneric, RawServer, RawRequest>,
      reply: FastifyReply<RawServer, RawRequest, RawReply, RouteGeneric, ContextConfig>
    ): void | Promise<any>;
    getOne?: boolean;
    getAll?: boolean;
    post?: boolean;
    patch?: boolean;
    delete?: boolean;
  }

  interface FastifyRequest {
    protected: boolean;
    authenticated: boolean;
    type: 'getOne' | 'getAll' | 'post' | 'patch' | 'delete';
  }
}

export interface RouteHandlerMethod extends IRouteHandlerMethod {}

export interface Route {
  uri: string;
  prefix: string;
  type: string;
}

export interface RouteModule {
  attributes: Object;
  requiredAttributes: string[];
  relationships: Object;
  requiredRelationships: string[];
  route: Route;
  type: string;
  getOneProtected: boolean;
  getAllProtected: boolean;
  postProtected: boolean;
  patchProtected: boolean;
  deleteProtected: boolean;
  middleware?: RouteHandlerMethod[];
}

let server: FastifyInstance;

export interface ServerOptions {
  port?: number;
  middleware?: RouteHandlerMethod[];
  authentication?: RouteHandlerMethod;
}

export interface GetParams {
  id: string;
}

export interface DeleteParams {
  id: string;
}

const defaultOptions: ServerOptions = {
  port: 3123,
};

let options: ServerOptions;

export default async function(callback: (server: FastifyInstance) => Promise<void>, opts: ServerOptions = {}) {
  options = opts;
  Object.keys(defaultOptions).forEach((key) => {
    if (typeof options[key] === 'undefined') {
      options[key] = defaultOptions[key];
    }
  });
  // Instantiate mongodb
  // const uri = "mongodb+srv://<username>:<password>@<your-cluster-url>/test?retryWrites=true&w=majority";
  const uri = 'mongodb://localhost:27017';
  const client = new MongoClient(uri, { useUnifiedTopology: true, useNewUrlParser: true });
  const db = await client.connect();

  // Instantiate fastify
  server = fastify({
    logger: true,
  });

  server.decorate('db', db);

  await loadRoutes(server);

  // Declare a route
  server.get('/', async (request, reply) => {
    reply.send({ hello: 'world' })
  });

  await callback(server);

  // Run the server!
  server.listen(options.port, () => (async (err, address) => {
    if (err) {
      server.log.error(err)
      process.exit(1)
    }
    server.log.info(`server listening on ${address}`)
  })().catch(console.error));
}

const loadRoutes = async (server: FastifyInstance) => {
  const routes = new Set<Route>();
  const loadFiles = async (prefix: string) => {
    let routeFiles;
    try {
      routeFiles = await fs.promises.readdir(prefix);
    } catch (e) {
      server.log.error('Error accessing routes');
      throw e;
    }
    for (const filename of routeFiles) {
      try {
        const filePath = path.join(prefix, filename);
        const stats = await fs.promises.stat(filePath);
        if (stats.isDirectory()) {
          routes.add({
            uri: filePath.replace(ROUTE_DIR, ''),
            prefix,
            type: filename,
          });
          await loadFiles(filePath);
        }
      } catch (e) {}
    }
  };
  await loadFiles(ROUTE_DIR);

  for (const route of routes) {
    const routeModule: RouteModule = require(fs.realpathSync(`./${path.join(ROUTE_DIR, route.uri)}`));
    server.log.info({ route, attributes: routeModule.attributes });
    routeModule.route = route;
    if (!routeModule.type) {
      routeModule.type = route.type;
    }
    let relationships;
    if (routeModule.relationships) {
      relationships = {}
      for (const relationshipName of Object.keys(routeModule.relationships)) {
        const relationship = routeModule.relationships[relationshipName];
        let typeName = relationshipName;
        if (relationship.relationship) {
          typeName = relationship.relationship;
        }
        if (relationship.many) {
          relationships[relationshipName] = {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: [typeName],
                },
                id: {
                  type: 'string',
                },
              },
              required: ['type', 'id'],
            },
          };
        } else {
          relationships[relationshipName] = {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: [typeName],
              },
              id: {
                type: 'string',
              },
            },
            required: ['type', 'id'],
          };
        }
      }
    }
    const validResponseObject = {
      type: 'object',
      properties: {
        id: {
          type: 'string',
        },
        type: {
          type: 'string',
        },
        attributes: {
          type: 'object',
          properties: {
            createdAt: {
              type: ['string', 'null'],
              format: 'date-time',
            },
            updatedAt: {
              type: ['string', 'null'],
              format: 'date-time',
            },
            deletedAt: {
              type: ['string', 'null'],
              format: 'date-time',
            },
            ...routeModule.attributes,
          },
        },
      },
    };
    const validListResponse = {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: validResponseObject,
        },
      },
    };
    const validSingleResponse = {
      type: 'object',
      properties: {
        data: validResponseObject,
      },
    };
    const validPost = {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: [routeModule.type]
            },
            attributes: {
              type: 'object',
              properties: routeModule.attributes,
              required: routeModule.requiredAttributes || Object.keys(routeModule.attributes),
            },
          },
          required: [
            'type',
            'attributes',
          ],
        },
      },
      required: [
        'data',
      ],
    };
    if (relationships) {
      validPost.properties.data.properties['relationships'] = {
        type: 'object',
        properties: relationships,
        required: routeModule.requiredRelationships || Object.keys(relationships),
      };
      if (routeModule.requiredRelationships && routeModule.requiredRelationships.length) {
        validPost.properties.data.required.push('relationships');
      }

      const getSchema = {
        type: 'object',
        properties: relationships,
      };

      validSingleResponse.properties.data.properties['relationships'] = getSchema;
      validListResponse.properties.data.items.properties['relationships'] = getSchema;
    }
    server.get(route.uri, {
      schema: {
        response: {
          200: validListResponse,
        },
      },
    }, await defaultRouteGet(routeModule));
    server.post(route.uri, {
      schema: {
        body: validPost,
        response: {
          200: validSingleResponse,
        },
      },
    }, await defaultRoutePost(routeModule));
    server.delete(`${route.uri}/:id`, {
      schema: {
        response: {
          204: {
            type: 'null',
          },
        },
      },
    }, await defaultRouteDelete(routeModule));
  }
};

export class FnfDone {}
export class FnfError {
  constructor(public options: JsonApiErrorOptions) {}
}

const setRequestType = async (request: FastifyRequest) => {
  if (request.method === 'GET') {
    if ((request.params as GetParams).id) {
      request.type = 'getOne';
    } else {
      request.type = 'getAll';
    }
  } else if (request.method === 'POST') {
    request.type = 'post';
  } else if (request.method === 'PATCH') {
    request.type = 'patch';
  } else if (request.method === 'DELETE') {
    request.type = 'delete';
  }
};

const doAuth = async (request: FastifyRequest, reply: FastifyReply, routeModule: RouteModule) => {
  if (routeModule[`${request.type}Protected`]) {
    request.protected = true;
  }
  if (options.authentication) {
    await options.authentication.bind(server)(request, reply);
    if (!request.authenticated) {
      throw new FnfError({
        request,
        reply,
        status: 401,
        title: 'Unauthorized',
        detail: 'This request requires authentication.',
        code: 'UNAUTHORIZED',
      });
    }
  }
};

const doMiddleWare = async (request: FastifyRequest, reply: FastifyReply, routeModule: RouteModule) => {
  if (options.middleware) {
    for (const middleFunc of options.middleware) {
      if (middleFunc[request.type]) await middleFunc.bind(server)(request, reply);
    }
  }
  if (routeModule.middleware) {
    for (const middleFunc of routeModule.middleware) {
      if (middleFunc[request.type]) await middleFunc.bind(server)(request, reply);
    }
  }
};

const preHooks = async (request: FastifyRequest, reply: FastifyReply, routeModule: RouteModule) => {
  await setRequestType(request);
  await doAuth(request, reply, routeModule);
  await doMiddleWare(request, reply, routeModule);
};

const handleError = async (request: FastifyRequest, reply: FastifyReply, routeModule: RouteModule, e: unknown) => {
  if (e instanceof FnfDone) {
    // intentionally blank
  } else if (e instanceof FnfError) {
    const status = e.options.status;
    reply.status(status).send(await jsonapiError(e.options));
  } else if (e instanceof Error) {
    server.log.error(e);
    const status = 500;
    reply.status(status).send(await jsonapiError({
      request,
      reply,
      status,
      title: 'Internal Server Error',
      code: 'UNKNOWN_ERROR',
      detail: e.message,
    }));
  } else {
    server.log.error(e as any);
    const status = 500;
    reply.status(status).send(await jsonapiError({
      request,
      reply,
      status,
      title: 'Internal Server Error',
      code: 'UNKNOWN_ERROR',
    }));
  }
};

const defaultRouteGet = async (routeModule: RouteModule): Promise<RouteHandlerMethod> => {
  return async (request, reply) => {
    try {
      await preHooks(request, reply, routeModule);

      // default behavior
      const db = server.db.db(DB_NAME);
      const collection = db.collection(routeModule.route.type);
      const documents = await collection.find({
        'attributes.deletedAt': {
          $exists: false,
        },
      }).project({ _id: 0 }).toArray();
      reply.status(200).send(await jsonapiResponse(documents));
    } catch (e) {
      await handleError(request, reply, routeModule, e);
    }
  };
};

const defaultRoutePost = async (routeModule: RouteModule): Promise<RouteHandlerMethod> => {
  return async (request, reply) => {
    try {
      await preHooks(request, reply, routeModule);

      // default behavior
      const now = new Date();
      const body: any = request.body;
      if (!body.data.attributes.createdAt) {
        body.data.attributes.createdAt = now;
      }
      if (!body.data.attributes.updatedAt) {
        body.data.attributes.updatedAt = null;
      }
      const db = server.db.db(DB_NAME);
      if (body.data.relationships) {
        for (const relationshipName of Object.keys(body.data.relationships)) {
          const relationship = body.data.relationships[relationshipName];
          const collection = db.collection(relationship.type);
          const document = await collection.findOne({
            id: relationship.id,
          });
          if (!document) {
            throw new FnfError({
              request,
              reply,
              status: 400,
              title: 'Bad Request',
              detail: `Relationship of type '${relationship.type}' by id '${relationship.id}' does not exist.`,
              code: 'BAD_REQUEST',
            });
          }
        }
      }
      const collection = db.collection(routeModule.route.type);
      if (body.data.id) {
        const document = await collection.findOne({
          id: body.data.id,
        });
        if (document) {
          throw new FnfError({
            request,
            reply,
            status: 400,
            title: 'Bad Request',
            detail: `A resource with the supplied id '${body.data.id}' already exists.`,
            code: 'BAD_REQUEST',
          });
        }
      } else {
        body.data.id = v4();
      }
      const result = await collection.insertOne(body.data);
      const document = await collection.findOne({
        _id: result.insertedId,
      });
      reply.status(200).send(await jsonapiResponse(document));
    } catch (e) {
      await handleError(request, reply, routeModule, e);
    }
  };
};

const defaultRouteDelete = async (routeModule: RouteModule): Promise<RouteHandlerMethod> => {
  return async (request, reply) => {
    try {
      await preHooks(request, reply, routeModule);

      // default behavior
      const { id } = request.params as DeleteParams;
      const now = new Date();
      const db = server.db.db(DB_NAME);
      const collection = db.collection(routeModule.route.type);
      const result = await collection.updateOne({
        id,
        'attributes.deletedAt': {
          $exists: false,
        },
      }, {
        $set: {
          'attributes.deletedAt': now,
        }
      });
      if (!result.modifiedCount) {
        const status = 404;
        return reply.status(status).send(await jsonapiError({
          request,
          reply,
          status,
          title: 'Not Found',
          code: 'NOT_FOUND',
          detail: 'The requested resource was not found.',
        }));
      }
      reply.status(204).send();
    } catch (e) {
      await handleError(request, reply, routeModule, e);
    }
  };
};

export const jsonapiResponse = async (data: Object | Object[]): Promise<any> => {
  if (Array.isArray(data)) {
    return {
      data,
    };
  } else {
    return {
      data,
    };
  }
};

export interface JsonApiErrorOptions {
  request: FastifyRequest;
  reply: FastifyReply;
  status: number;
  title: string;
  detail?: string;
  code?: string;
}

export const jsonapiError = async ({
  request,
  reply,
  status,
  title,
  detail,
  code,
}: JsonApiErrorOptions) => {
  return {
    errors: [{
      id: `${process.pid}-${request.id}`,
      status,
      code,
      title,
      detail,
    }]
  };
}
