/*
 * Heuristic prompt-injection detection for text addressed to the bot (conversation routing) only.
 * Never apply it to code/diffs: a suspicious string must not let a change skip review. Injection in code is
 * handled by the security preamble and output sanitization.
 */

export interface InjectionSignal {
  suspicious: boolean;
  /** Matched labels, deduplicated. */
  patterns: string[];
}

const PATTERNS: { re: RegExp; label: string }[] = [
  { re: /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|above|prior|earlier|foregoing)\s+(?:instructions?|prompts?|messages?|context|rules?)/i, label: 'ignore-previous' },
  { re: /disregard\s+(?:all\s+)?(?:the\s+)?(?:previous|above|prior|foregoing)\b/i, label: 'disregard' },
  { re: /(?:print|reveal|show|output|repeat|dump|display|leak|expose)\s+(?:me\s+)?(?:your|the)\s+(?:full\s+|entire\s+|complete\s+|system\s+)*(?:system\s+)?(?:prompt|instructions?|rules?|configuration|guidelines?|preamble)/i, label: 'reveal-prompt' },
  { re: /what\s+(?:are|were|is)\s+your\s+(?:system\s+)?(?:instructions?|rules?|prompt|guidelines?)/i, label: 'ask-prompt' },
  { re: /(?:from\s+now\s+on|starting\s+now)[,:]?\s+you\s+(?:are|will|must|should)|you\s+are\s+now\s+(?:a|an|in)\b|pretend\s+(?:to\s+be|you\s+are)|act\s+as\s+(?:if|a|an)\b/i, label: 'role-override' },
  { re: /(?:output|repeat|print|echo)\s+(?:everything|all|the\s+(?:text|words|content))\s+(?:above|before|preceding)/i, label: 'output-above' },
  { re: /reveal\s+(?:your|the|all)\s+(?:tools?|functions?|schemas?|capabilities)/i, label: 'reveal-tools' },
  { re: /\bDAN\b|jail\s?break|developer\s+mode|do\s+anything\s+now/i, label: 'jailbreak' },
];

export function detectInjectionAttempt(text: string): InjectionSignal {
  const patterns = new Set<string>();
  for (const { re, label } of PATTERNS) {
    if (re.test(text)) patterns.add(label);
  }
  return { suspicious: patterns.size > 0, patterns: [...patterns] };
}
