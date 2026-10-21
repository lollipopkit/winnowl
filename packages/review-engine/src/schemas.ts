import { Type } from '@reviewbot/agent-pi';

const OBLIGATION = Type.Object({
  kind: Type.String(),
  description: Type.String(),
});

export const COMPLETE_MAP_SCHEMA = Type.Object({
  scopes: Type.Array(
    Type.Object({
      title: Type.String(),
      changeSummary: Type.String(),
      obligations: Type.Array(OBLIGATION),
      // Prefetched into the scope's dig to save read round-trips.
      files: Type.Optional(Type.Array(Type.String())),
    }),
  ),
});

export const SUBMIT_CANDIDATE_SCHEMA = Type.Object({
  claim: Type.String(),
  category: Type.String(),
  suspectedSeverity: Type.Union([
    Type.Literal('critical'),
    Type.Literal('high'),
    Type.Literal('medium'),
    Type.Literal('low'),
  ]),
  path: Type.String(),
  primaryAnchorText: Type.String(),
  changeRelationHypothesis: Type.Union([
    Type.Literal('introduced'),
    Type.Literal('exposed'),
    Type.Literal('regressed'),
    Type.Literal('preexisting-relevant'),
    Type.Literal('preexisting-unrelated'),
    Type.Literal('unknown'),
  ]),
});

export const REMEMBER_SCHEMA = Type.Object({
  kind: Type.Union(
    [
      Type.Literal('repo-quirk'),
      Type.Literal('false-positive-pattern'),
      Type.Literal('reviewer-pref'),
      Type.Literal('arch-note'),
    ],
    {
      description:
        'repo-quirk = build/layout/convention; false-positive-pattern = a claim class that looked like a bug but is NOT here (say why); arch-note.',
    },
  ),
  title: Type.String({ description: 'Short stable key for this fact.' }),
  summary: Type.String({ description: 'One line; future reviews decide relevance from this.' }),
  body: Type.String({ description: 'Details, concrete and verifiable.' }),
  selector: Type.Optional(
    Type.String({ description: 'Path glob if only relevant for part of the repo.' }),
  ),
});

/** Ecosystem-wide facts verified with web tools during the review. */
export const RECORD_EXTERNAL_FACT_SCHEMA = Type.Object({
  ecosystem: Type.String({
    description: 'npm | pypi | cargo | go | pub | maven | rubygems | nuget | composer | hex | other (languages, SDKs and tools outside these registries).',
  }),
  subject: Type.String({
    description: 'The exact package or SDK name as it appears in dependency manifests (e.g. material_ui, flutter, groupId:artifactId for maven).',
  }),
  versions: Type.Optional(
    Type.String({
      description:
        'The range of the subject\'s versions the fact holds for, e.g. ">=3.47.0" or "<2.0.0" — not the latest version. Omit if it holds for every version.',
    }),
  ),
  claim: Type.String({ description: 'One sentence stating the fact, e.g. "Flutter 3.47 ships Material as the standalone material_ui package; the in-SDK library is frozen and will be deprecated".' }),
  detail: Type.Optional(Type.String({ description: 'Consequences and migration steps a reviewer needs; concrete, no repository details.' })),
  sources: Type.Array(Type.String(), {
    minItems: 1,
    maxItems: 5,
    description: 'URLs that the lookup tools returned in this review and that state the fact (a web_search result, a fetch_url page, the registry or docs looked up). Others are discarded.',
  }),
});

export const COMPLETE_SCOPE_SCHEMA = Type.Object({
  status: Type.Union([
    Type.Literal('complete'),
    Type.Literal('incomplete'),
    Type.Literal('blocked'),
    Type.Literal('failed'),
  ]),
  // Narrows coverage accounting (coveredPathsOf); the description is the only format constraint on the model.
  exploredEntities: Type.Array(Type.String(), {
    description:
      'Repository-relative paths (as given in the scope, e.g. "src/app/main.ts") you actually opened. Not symbol names, not absolute paths.',
  }),
  // Reused as known context next round if the file is unchanged, or as a possibly stale note with the inter-round diff.
  fileNotes: Type.Optional(
    Type.Array(
      Type.Object({
        path: Type.String({ description: 'A changed file of this scope, as given in the scope.' }),
        summary: Type.String({
          maxLength: 600,
          description:
            'One to three sentences: what this change does to the file, what it relies on elsewhere, and what you verified. Facts only, no findings.',
        }),
      }),
    ),
  ),
  // Requested only for scopes that skipped map and so have no map-written summary (see walkthroughOf).
  walkthrough: Type.Optional(
    Type.Object(
      {
        title: Type.String({ maxLength: 120, description: 'A short name for what the change does.' }),
        summary: Type.String({ maxLength: 400, description: 'One or two sentences on what the change does and why.' }),
      },
      { description: 'Only when the task asks for it: the pull request walkthrough entry for this section.' },
    ),
  ),
});

export const COMPLETE_SYNTHESIS_SCHEMA = Type.Object({
  note: Type.String(),
});

/** Subagents submit findings themselves; the report stays a short answer so the parent does not pay output tokens twice. */
export const SUBAGENT_REPORT_SCHEMA = Type.Object({
  answer: Type.String({
    description:
      'What you found out, in a few sentences. Written for someone who did not see your steps.',
  }),
  checked: Type.Array(Type.String(), { description: 'Files or symbols you actually looked at.' }),
});
