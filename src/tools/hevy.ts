import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { formatUnknownError } from '../errors.js';
import { writeAuditEvent } from '../hevy/audit.js';
import { HEVY_CAPABILITIES, READ_ANNOTATIONS, REPLACE_ANNOTATIONS, WRITE_ANNOTATIONS, searchCapabilities } from '../hevy/capabilities.js';
import type { HevyClient } from '../hevy/client.js';
import { assertWritesEnabled, requireUser } from '../hevy/policy.js';
import type { CredentialStore } from '../hevy/store.js';

export interface RegisterOptions {
  onBehalfOf?: string;
  /** Public base URL used to build the enrollment link (HEVY_PUBLIC_BASE_URL). */
  publicBaseUrl?: string;
}

// Hevy caps page size per resource; clamp rather than let the API 400.
const page = z.number().int().min(1).default(1);
const smallPageSize = z.number().int().min(1).max(10).default(10);
const templatePageSize = z.number().int().min(1).max(100).default(100);

const SET_TYPES = ['warmup', 'normal', 'failure', 'dropset'] as const;
const RPE_VALUES = [6, 7, 7.5, 8, 8.5, 9, 9.5, 10] as const;

/** Weights are ALWAYS kg and durations ALWAYS seconds — Hevy has no unit fields. */
const workoutSet = z.object({
  type: z.enum(SET_TYPES).default('normal'),
  weight_kg: z.number().nullable().optional(),
  reps: z.number().int().nullable().optional(),
  distance_meters: z.number().int().nullable().optional(),
  duration_seconds: z.number().int().nullable().optional(),
  custom_metric: z.number().nullable().optional(),
  rpe: z.enum(RPE_VALUES.map(String) as [string, ...string[]]).transform(Number).nullable().optional(),
});

const workoutExercise = z.object({
  exercise_template_id: z.string().min(1).describe('From hevy_search_exercise_templates.'),
  superset_id: z.number().int().nullable().optional(),
  notes: z.string().nullable().optional(),
  sets: z.array(workoutSet).min(1),
});

const routineSet = workoutSet
  .omit({ rpe: true })
  .extend({ rep_range: z.object({ start: z.number().int(), end: z.number().int() }).nullable().optional() });

const routineExercise = z.object({
  exercise_template_id: z.string().min(1),
  superset_id: z.number().int().nullable().optional(),
  rest_seconds: z.number().int().nullable().optional(),
  notes: z.string().nullable().optional(),
  sets: z.array(routineSet).min(1),
});

export function registerHevyTools(
  server: McpServer,
  client: HevyClient,
  store: CredentialStore,
  options: RegisterOptions = {},
): void {
  const writeEnabled = process.env.HEVY_ENABLE_WRITES === 'true';
  const available = new Set(
    HEVY_CAPABILITIES.filter(c => writeEnabled || c.risk !== 'write').map(c => c.id),
  );
  const user = () => requireUser(options.onBehalfOf);
  const call = <T>(method: 'GET' | 'POST' | 'PUT', path: string, opts?: { query?: Record<string, string | number | undefined>; body?: unknown }) =>
    client.request<T>(user(), store, method, path, opts ?? {});

  // --- discovery + auth -----------------------------------------------------

  server.registerTool(
    'hevy_search_capabilities',
    { title: 'Search Hevy Capabilities', description: 'Find the right Hevy tool. Use first.', inputSchema: { query: z.string().trim().default(''), limit: z.number().int().min(1).max(50).default(20) }, annotations: READ_ANNOTATIONS },
    async input => run('hevy_search_capabilities', options, input, async () => json(searchCapabilities(input.query, available, input.limit))),
  );

  server.registerTool(
    'hevy_connect',
    {
      title: 'Connect Hevy account',
      description:
        'Start linking YOUR Hevy account. Returns a one-time link to a form where you paste your Hevy API key — the key is never sent through this conversation. Get the key from hevy.com/settings?developer in a BROWSER (it is not in the mobile app) — it requires an active Hevy Pro subscription.',
      inputSchema: {},
      annotations: { ...WRITE_ANNOTATIONS, readOnlyHint: false },
    },
    async input =>
      run('hevy_connect', options, input, async () => {
        const u = user();
        const base = (options.publicBaseUrl ?? process.env.HEVY_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
        if (!base) {
          throw new Error('HEVY_PUBLIC_BASE_URL is not configured, so no enrollment link can be generated.');
        }
        const state = store.createState(u);
        return json({
          alreadyConnected: Boolean(store.get(u)),
          enrollmentUrl: `${base}/hevy/enroll?state=${state}`,
          instructions:
            'Open enrollmentUrl in your browser and paste your Hevy API key (hevy.com/settings?developer, requires Hevy Pro). The link is single-use and expires in 10 minutes.',
        });
      }),
  );

  server.registerTool(
    'hevy_status',
    { title: 'Hevy Connection Status', description: 'Whether your Hevy account is linked.', inputSchema: {}, annotations: READ_ANNOTATIONS },
    async input =>
      run('hevy_status', options, input, async () => {
        const credentials = store.get(user());
        if (!credentials) {
          return json({ connected: false, hint: 'Run hevy_connect to link your Hevy account.' });
        }
        return json({ connected: true, connectedAt: new Date(credentials.connectedAt).toISOString() });
      }),
  );

  server.registerTool(
    'hevy_disconnect',
    { title: 'Disconnect Hevy', description: 'Remove your stored Hevy API key from this server.', inputSchema: {}, annotations: REPLACE_ANNOTATIONS },
    async input => run('hevy_disconnect', options, input, async () => json({ disconnected: store.delete(user()) })),
  );

  // --- workouts (read) ------------------------------------------------------

  server.registerTool(
    'hevy_get_workouts',
    { title: 'Get Workouts', description: 'Your logged workouts, newest first, with full exercise and set detail. Max 10 per page.', inputSchema: { page, pageSize: smallPageSize }, annotations: READ_ANNOTATIONS },
    async input => run('hevy_get_workouts', options, input, async () => json(await call('GET', '/v1/workouts', { query: { page: input.page, pageSize: input.pageSize } }))),
  );

  server.registerTool(
    'hevy_get_workout',
    { title: 'Get Workout', description: 'One workout by id.', inputSchema: { workoutId: z.string().min(1) }, annotations: READ_ANNOTATIONS },
    async input => run('hevy_get_workout', options, input, async () => json(await call('GET', `/v1/workouts/${encodeURIComponent(input.workoutId)}`))),
  );

  server.registerTool(
    'hevy_get_workout_count',
    { title: 'Workout Count', description: 'Total number of workouts you have logged.', inputSchema: {}, annotations: READ_ANNOTATIONS },
    async input => run('hevy_get_workout_count', options, input, async () => json(await call('GET', '/v1/workouts/count'))),
  );

  server.registerTool(
    'hevy_get_workout_events',
    { title: 'Workout Events (sync)', description: 'Workouts updated or deleted since a timestamp — use for incremental sync rather than re-reading everything.', inputSchema: { since: z.string().default('1970-01-01T00:00:00Z').describe('ISO 8601 UTC.'), page, pageSize: smallPageSize }, annotations: READ_ANNOTATIONS },
    async input => run('hevy_get_workout_events', options, input, async () => json(await call('GET', '/v1/workouts/events', { query: { since: input.since, page: input.page, pageSize: input.pageSize } }))),
  );

  server.registerTool(
    'hevy_get_exercise_history',
    { title: 'Exercise History', description: 'Every recorded set for one exercise template over time — the right tool for judging progression on a specific lift.', inputSchema: { exerciseTemplateId: z.string().min(1), startDate: z.string().optional().describe('ISO 8601 UTC'), endDate: z.string().optional() }, annotations: READ_ANNOTATIONS },
    async input =>
      run('hevy_get_exercise_history', options, input, async () =>
        json(await call('GET', `/v1/exercise_history/${encodeURIComponent(input.exerciseTemplateId)}`, { query: { start_date: input.startDate, end_date: input.endDate } })),
      ),
  );

  // --- routines (read) ------------------------------------------------------

  server.registerTool(
    'hevy_get_routines',
    { title: 'Get Routines', description: 'Your saved routines (training templates). Max 10 per page.', inputSchema: { page, pageSize: smallPageSize }, annotations: READ_ANNOTATIONS },
    async input => run('hevy_get_routines', options, input, async () => json(await call('GET', '/v1/routines', { query: { page: input.page, pageSize: input.pageSize } }))),
  );

  server.registerTool(
    'hevy_get_routine',
    { title: 'Get Routine', description: 'One routine by id. Always fetch this before hevy_update_routine — updates replace the entire routine.', inputSchema: { routineId: z.string().min(1) }, annotations: READ_ANNOTATIONS },
    async input => run('hevy_get_routine', options, input, async () => json(await call('GET', `/v1/routines/${encodeURIComponent(input.routineId)}`))),
  );

  server.registerTool(
    'hevy_get_routine_folders',
    { title: 'Get Routine Folders', description: 'Your routine folders.', inputSchema: { page, pageSize: smallPageSize }, annotations: READ_ANNOTATIONS },
    async input => run('hevy_get_routine_folders', options, input, async () => json(await call('GET', '/v1/routine_folders', { query: { page: input.page, pageSize: input.pageSize } }))),
  );

  // --- exercise templates + profile ----------------------------------------

  server.registerTool(
    'hevy_search_exercise_templates',
    {
      title: 'Search Exercise Templates',
      description:
        'Find exercise templates by name to get the exercise_template_id needed for creating workouts/routines. Hevy has no server-side search, so this pages through templates and filters locally.',
      inputSchema: { query: z.string().trim().default('').describe('Case-insensitive substring of the exercise title.'), maxPages: z.number().int().min(1).max(20).default(5), pageSize: templatePageSize },
      annotations: READ_ANNOTATIONS,
    },
    async input =>
      run('hevy_search_exercise_templates', options, input, async () => {
        const q = input.query.toLowerCase();
        const matches: unknown[] = [];
        let pageNo = 1;
        let pageCount = 1;
        while (pageNo <= Math.min(input.maxPages, pageCount)) {
          const body = await call<{ page_count?: number; exercise_templates?: Array<{ title?: string }> }>('GET', '/v1/exercise_templates', {
            query: { page: pageNo, pageSize: input.pageSize },
          });
          pageCount = body.page_count ?? 1;
          for (const t of body.exercise_templates ?? []) {
            if (!q || (t.title ?? '').toLowerCase().includes(q)) {
              matches.push(t);
            }
          }
          pageNo += 1;
        }
        return json({ query: input.query, count: matches.length, pagesScanned: pageNo - 1, totalPages: pageCount, exercise_templates: matches });
      }),
  );

  server.registerTool(
    'hevy_get_exercise_template',
    { title: 'Get Exercise Template', description: 'One exercise template by id.', inputSchema: { exerciseTemplateId: z.string().min(1) }, annotations: READ_ANNOTATIONS },
    async input => run('hevy_get_exercise_template', options, input, async () => json(await call('GET', `/v1/exercise_templates/${encodeURIComponent(input.exerciseTemplateId)}`))),
  );

  server.registerTool(
    'hevy_get_user_info',
    { title: 'Get User Info', description: 'Your Hevy profile (id, name, profile URL).', inputSchema: {}, annotations: READ_ANNOTATIONS },
    async input => run('hevy_get_user_info', options, input, async () => json(await call('GET', '/v1/user/info'))),
  );

  server.registerTool(
    'hevy_get_body_measurements',
    {
      title: 'Get Body Measurements',
      description:
        'Body measurements stored in Hevy. READ-ONLY here by design: Withings is the source of truth for body weight and composition, so this server deliberately does not write measurements and create a second competing record.',
      inputSchema: { page, pageSize: smallPageSize },
      annotations: READ_ANNOTATIONS,
    },
    async input => run('hevy_get_body_measurements', options, input, async () => json(await call('GET', '/v1/body_measurements', { query: { page: input.page, pageSize: input.pageSize } }))),
  );

  // --- writes ---------------------------------------------------------------
  // Registered only when HEVY_ENABLE_WRITES=true, so a read-only deployment
  // doesn't advertise tools that will refuse.
  if (!writeEnabled) {
    return;
  }

  server.registerTool(
    'hevy_create_workout',
    {
      title: 'Log a Workout',
      description:
        'Create a new logged workout. Weights are kilograms and durations seconds. NOT idempotent — if this errors, check hevy_get_workouts before retrying, or you may create a duplicate.',
      inputSchema: {
        title: z.string().min(1),
        start_time: z.string().describe('ISO 8601 UTC, e.g. 2026-08-16T17:00:00Z'),
        end_time: z.string(),
        description: z.string().nullable().optional(),
        is_private: z.boolean().default(false),
        exercises: z.array(workoutExercise).min(1),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async input =>
      run('hevy_create_workout', options, input, async () => {
        assertWritesEnabled('hevy_create_workout');
        const { title, start_time, end_time, description, is_private, exercises } = input;
        return json(await call('POST', '/v1/workouts', { body: { workout: { title, start_time, end_time, description: description ?? null, is_private, exercises } } }));
      }),
  );

  server.registerTool(
    'hevy_update_workout',
    {
      title: 'Replace a Workout',
      description:
        'REPLACES a workout in full. Hevy has no partial update: every exercise and set you omit is erased. Fetch the workout first and resend the complete object with your changes applied.',
      inputSchema: {
        workoutId: z.string().min(1),
        title: z.string().min(1),
        start_time: z.string(),
        end_time: z.string(),
        description: z.string().nullable().optional(),
        is_private: z.boolean().default(false),
        exercises: z.array(workoutExercise).min(1),
      },
      annotations: REPLACE_ANNOTATIONS,
    },
    async input =>
      run('hevy_update_workout', options, input, async () => {
        assertWritesEnabled('hevy_update_workout');
        const { workoutId, title, start_time, end_time, description, is_private, exercises } = input;
        return json(await call('PUT', `/v1/workouts/${encodeURIComponent(workoutId)}`, { body: { workout: { title, start_time, end_time, description: description ?? null, is_private, exercises } } }));
      }),
  );

  server.registerTool(
    'hevy_create_routine',
    {
      title: 'Create a Routine',
      description: 'Create a new routine (training template). Routine sets may use a fixed reps value or a rep_range {start,end}. rest_seconds is per exercise.',
      inputSchema: {
        title: z.string().min(1),
        folder_id: z.number().int().nullable().optional().describe('null puts it in the default "My Routines" folder.'),
        notes: z.string().nullable().optional(),
        exercises: z.array(routineExercise).min(1),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async input =>
      run('hevy_create_routine', options, input, async () => {
        assertWritesEnabled('hevy_create_routine');
        const { title, folder_id, notes, exercises } = input;
        return json(await call('POST', '/v1/routines', { body: { routine: { title, folder_id: folder_id ?? null, notes: notes ?? null, exercises } } }));
      }),
  );

  server.registerTool(
    'hevy_update_routine',
    {
      title: 'Replace a Routine',
      description:
        'REPLACES a routine in full. Every exercise and set you omit is erased — always call hevy_get_routine first and resend the complete object with only your intended changes applied.',
      inputSchema: {
        routineId: z.string().min(1),
        title: z.string().min(1),
        folder_id: z.number().int().nullable().optional(),
        notes: z.string().nullable().optional(),
        exercises: z.array(routineExercise).min(1),
      },
      annotations: REPLACE_ANNOTATIONS,
    },
    async input =>
      run('hevy_update_routine', options, input, async () => {
        assertWritesEnabled('hevy_update_routine');
        const { routineId, title, folder_id, notes, exercises } = input;
        return json(await call('PUT', `/v1/routines/${encodeURIComponent(routineId)}`, { body: { routine: { title, folder_id: folder_id ?? null, notes: notes ?? null, exercises } } }));
      }),
  );

  server.registerTool(
    'hevy_create_routine_folder',
    { title: 'Create a Routine Folder', description: 'Create a routine folder. It is inserted at the top and existing folders shift down. Folders cannot be renamed or deleted via the API.', inputSchema: { title: z.string().min(1) }, annotations: WRITE_ANNOTATIONS },
    async input =>
      run('hevy_create_routine_folder', options, input, async () => {
        assertWritesEnabled('hevy_create_routine_folder');
        return json(await call('POST', '/v1/routine_folders', { body: { routine_folder: { title: input.title } } }));
      }),
  );

  server.registerTool(
    'hevy_create_exercise_template',
    {
      title: 'Create a Custom Exercise',
      description: 'Create a custom exercise template when no built-in Hevy exercise matches. Cannot be updated or deleted afterwards, and accounts have a custom-exercise limit.',
      inputSchema: {
        title: z.string().min(1),
        exercise_type: z.enum(['weight_reps', 'reps_only', 'bodyweight_reps', 'bodyweight_assisted_reps', 'duration', 'weight_duration', 'distance_duration', 'short_distance_weight']),
        equipment_category: z.enum(['none', 'barbell', 'dumbbell', 'kettlebell', 'machine', 'plate', 'resistance_band', 'suspension', 'other']),
        muscle_group: z.string().min(1).describe('e.g. chest, lats, quadriceps, hamstrings, glutes, shoulders, biceps, triceps'),
        other_muscles: z.array(z.string()).default([]),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async input =>
      run('hevy_create_exercise_template', options, input, async () => {
        assertWritesEnabled('hevy_create_exercise_template');
        const { title, exercise_type, equipment_category, muscle_group, other_muscles } = input;
        return json(await call('POST', '/v1/exercise_templates', { body: { exercise: { title, exercise_type, equipment_category, muscle_group, other_muscles } } }));
      }),
  );
}

async function run<T>(tool: string, options: RegisterOptions, input: unknown, fn: () => Promise<T>): Promise<T> {
  const actingAs = options.onBehalfOf ?? '(no identity)';
  await writeAuditEvent({ tool, actingAs, action: 'start', target: auditTarget(input) });
  try {
    const result = await fn();
    await writeAuditEvent({ tool, actingAs, action: 'finish', status: 'ok' });
    return result;
  } catch (error) {
    await writeAuditEvent({ tool, actingAs, action: 'error', status: 'error', error: formatUnknownError(error) });
    throw error;
  }
}

/** Log identifiers only — never workout contents. */
function auditTarget(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const v = input as Record<string, unknown>;
  return { workoutId: v.workoutId, routineId: v.routineId, exerciseTemplateId: v.exerciseTemplateId, title: v.title, query: v.query };
}

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
