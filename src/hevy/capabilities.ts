export interface Capability {
  id: string;
  title: string;
  description: string;
  risk: 'read' | 'write' | 'auth';
  keywords: string[];
}

export const READ_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
export const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
/** PUT on Hevy REPLACES the whole record — omitted fields are erased. */
export const REPLACE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

const SELF = 'Only ever returns YOUR OWN Hevy data (bound to your verified identity).';

export const HEVY_CAPABILITIES: Capability[] = [
  { id: 'hevy_search_capabilities', title: 'Search Hevy Capabilities', description: 'Find the right Hevy tool.', risk: 'read', keywords: ['help', 'discover'] },
  { id: 'hevy_connect', title: 'Connect Hevy account', description: 'Link YOUR Hevy account by pasting your API key into a one-time browser form. Requires Hevy Pro.', risk: 'auth', keywords: ['connect', 'link', 'auth', 'api key', 'forbind'] },
  { id: 'hevy_status', title: 'Hevy Connection Status', description: 'Whether your Hevy account is linked.', risk: 'read', keywords: ['status', 'connected'] },
  { id: 'hevy_disconnect', title: 'Disconnect Hevy', description: 'Remove your stored Hevy API key from this server.', risk: 'auth', keywords: ['disconnect', 'revoke', 'logout'] },

  { id: 'hevy_get_workouts', title: 'Get Workouts', description: `Recent logged workouts with exercises and sets. ${SELF}`, risk: 'read', keywords: ['workouts', 'træning', 'history', 'log'] },
  { id: 'hevy_get_workout', title: 'Get Workout', description: `One workout by id, with full exercise/set detail. ${SELF}`, risk: 'read', keywords: ['workout', 'detail'] },
  { id: 'hevy_get_workout_count', title: 'Workout Count', description: `Total number of workouts you have logged. ${SELF}`, risk: 'read', keywords: ['count', 'total'] },
  { id: 'hevy_get_workout_events', title: 'Workout Events (sync)', description: `Workouts updated or deleted since a timestamp — for incremental sync. ${SELF}`, risk: 'read', keywords: ['events', 'sync', 'changes'] },
  { id: 'hevy_get_exercise_history', title: 'Exercise History', description: `Past sets for one exercise template over time — the tool for judging progression on a lift. ${SELF}`, risk: 'read', keywords: ['history', 'progression', 'exercise', 'progress'] },

  { id: 'hevy_get_routines', title: 'Get Routines', description: `Your saved routines (templates), with planned exercises and sets. ${SELF}`, risk: 'read', keywords: ['routines', 'program', 'plan'] },
  { id: 'hevy_get_routine', title: 'Get Routine', description: `One routine by id. Fetch this before updating — updates replace the whole routine. ${SELF}`, risk: 'read', keywords: ['routine', 'detail'] },
  { id: 'hevy_get_routine_folders', title: 'Get Routine Folders', description: `Your routine folders. ${SELF}`, risk: 'read', keywords: ['folders'] },

  { id: 'hevy_search_exercise_templates', title: 'Search Exercise Templates', description: 'Find exercise templates by name — needed to get the exercise_template_id used when creating workouts or routines.', risk: 'read', keywords: ['exercise', 'template', 'search', 'øvelse'] },
  { id: 'hevy_get_exercise_template', title: 'Get Exercise Template', description: 'One exercise template by id.', risk: 'read', keywords: ['exercise', 'template'] },

  { id: 'hevy_get_user_info', title: 'Get User Info', description: `Your Hevy profile (id, name, profile URL). ${SELF}`, risk: 'read', keywords: ['profile', 'user', 'me'] },
  { id: 'hevy_get_body_measurements', title: 'Get Body Measurements', description: `Body measurements recorded in Hevy. Read-only here — Withings is the source of truth for body weight and composition. ${SELF}`, risk: 'read', keywords: ['weight', 'body', 'measurements', 'vægt'] },

  { id: 'hevy_create_workout', title: 'Log a Workout', description: 'Create a new logged workout. Requires write access. Not idempotent — a retry creates a duplicate.', risk: 'write', keywords: ['log', 'create', 'workout'] },
  { id: 'hevy_update_workout', title: 'Replace a Workout', description: 'REPLACES an existing workout in full — any field or set you omit is erased. Fetch it first.', risk: 'write', keywords: ['update', 'edit', 'workout'] },
  { id: 'hevy_create_routine', title: 'Create a Routine', description: 'Create a new routine (training template). Requires write access.', risk: 'write', keywords: ['create', 'routine', 'program'] },
  { id: 'hevy_update_routine', title: 'Replace a Routine', description: 'REPLACES an existing routine in full — any exercise or set you omit is erased. Fetch it first with hevy_get_routine.', risk: 'write', keywords: ['update', 'edit', 'routine'] },
  { id: 'hevy_create_routine_folder', title: 'Create a Routine Folder', description: 'Create a routine folder. New folders are inserted at the top.', risk: 'write', keywords: ['folder', 'create'] },
  { id: 'hevy_create_exercise_template', title: 'Create a Custom Exercise', description: 'Create a custom exercise template when Hevy has no matching built-in exercise.', risk: 'write', keywords: ['custom', 'exercise', 'create'] },
];

export function searchCapabilities(query: string, available: Set<string>, limit = 20): Capability[] {
  const pool = HEVY_CAPABILITIES.filter(c => available.has(c.id));
  const q = query.trim().toLowerCase();
  if (!q) {
    return pool.slice(0, limit);
  }
  const terms = q.split(/\s+/).filter(Boolean);
  return pool
    .map(c => ({ c, score: terms.reduce((s, t) => s + ([c.id, c.title, c.description, ...c.keywords].join(' ').toLowerCase().includes(t) ? 1 : 0), 0) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.c);
}
