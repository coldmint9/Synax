import {
  remoteExtensionSources,
  saveRemoteSource,
  syncRemoteSource,
} from '../services/extensions/remote-source.js';
import { Hono } from 'hono';
import * as z from 'zod/v4';
import {
  extensionSources,
  listExtensions,
} from '../services/extensions/extension-catalog.js';
import { extensionStore } from '../services/extensions/extension-store.js';
import {
  changeExtensionState,
  extensionDetail,
  installExtension,
  saveCustomExtension,
} from '../services/extensions/extension-service.js';
import {
  customExtensionSchema,
  extensionKindSchema,
} from '../services/extensions/schemas.js';

export const extensionRoutes = new Hono();
extensionRoutes.onError((error, c) =>
  c.json({ error: error.message }, error instanceof z.ZodError ? 400 : 409),
);
const querySchema = z.object({
  view: z.enum(['installed', 'market']).default('installed'),
  kind: extensionKindSchema.optional(),
  source: z.string().max(128).optional(),
  q: z.string().max(256).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
extensionRoutes.get('/:projectId/extensions', async (c) =>
  c.json(
    await listExtensions(
      c.req.param('projectId'),
      querySchema.parse(c.req.query()),
    ),
  ),
);
extensionRoutes.get('/:projectId/extensions/sources', (c) =>
  c.json({
    items: extensionSources(),
    directories: extensionStore.directories(c.req.param('projectId')),
  }),
);
extensionRoutes.post('/:projectId/extensions/sources', async (c) => {
  const input = z
    .object({
      id: z.string().regex(/^[a-z0-9-]{1,64}$/),
      name: z.string().trim().min(1).max(128),
      url: z.url(),
    })
    .parse(await c.req.json());
  if (
    remoteExtensionSources().some(
      (source) => source.id === `catalog/${input.id}`,
    )
  )
    return c.json({ error: 'A source with this id already exists' }, 409);
  return c.json(await saveRemoteSource(input), 201);
});
extensionRoutes.post('/:projectId/extensions/sources/:id/sync', async (c) =>
  c.json(await syncRemoteSource(c.req.param('id'))),
);
extensionRoutes.put('/:projectId/extensions/sources/local', async (c) => {
  const { directories } = z
    .object({ directories: z.array(z.string().min(1).max(4096)).max(8) })
    .parse(await c.req.json());
  extensionStore.setDirectories(c.req.param('projectId'), directories);
  return c.json({ ok: true });
});
extensionRoutes.post('/:projectId/extensions/custom', async (c) =>
  c.json(
    {
      definition: saveCustomExtension(
        c.req.param('projectId'),
        customExtensionSchema.parse(await c.req.json()),
      ),
    },
    201,
  ),
);
extensionRoutes.post('/:projectId/extensions/install', async (c) => {
  const input = z
    .object({
      kind: extensionKindSchema,
      id: z.string().min(1).max(512),
      locator: z
        .object({
          sourceId: z.string().max(128),
          name: z.string().max(128),
          remoteUrl: z.url().optional(),
          discoveryId: z.string().max(256).optional(),
        })
        .optional(),
    })
    .parse(await c.req.json());
  return c.json({
    id: await installExtension(c.req.param('projectId'), input),
  });
});
extensionRoutes.get('/:projectId/extensions/:kind/:id', (c) =>
  c.json(
    extensionDetail(
      c.req.param('projectId'),
      extensionKindSchema.parse(c.req.param('kind')),
      c.req.param('id'),
    ),
  ),
);
extensionRoutes.post('/:projectId/extensions/:kind/:id/state', async (c) => {
  const { action } = z
    .object({ action: z.enum(['enable', 'disable', 'uninstall']) })
    .parse(await c.req.json());
  changeExtensionState(
    c.req.param('projectId'),
    extensionKindSchema.parse(c.req.param('kind')),
    c.req.param('id'),
    action,
  );
  return c.json({ ok: true });
});
