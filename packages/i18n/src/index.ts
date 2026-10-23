/**
 * i18n fragments shared across UI packages, spread into each package's own typesafe-i18n dictionaries.
 * en is the base and carries the interpolation types (`{x:number}`); other locales just use `{x}`.
 */

export const en = {
  list: {
    search: 'Search',
    searchAccount: 'Search account…',
    searchRepo: 'Search namespace or repository name…',
    searchClaim: 'Search claim…',
    searchActor: 'Search actor / target…',
    all: 'All',
    allRepositories: 'All repositories',
    prev: 'Prev',
    next: 'Next',
    range: '{from:number}–{to:number} of {total:number}',
    empty: 'No matching results.',
    reset: 'Reset',
    clearFilters: 'Clear filters',
    total: '{total:number} total',
    pagination: 'Pagination',
  },
} as const;

export const zh = {
  list: {
    search: '搜索',
    searchAccount: '搜索账号…',
    searchRepo: '搜索命名空间或仓库名…',
    searchClaim: '搜索结论…',
    searchActor: '搜索操作者 / 目标…',
    all: '全部',
    allRepositories: '全部仓库',
    prev: '上一页',
    next: '下一页',
    range: '{from}–{to} / 共 {total}',
    empty: '没有找到结果。',
    reset: '重置',
    clearFilters: '清除筛选',
    total: '共 {total} 条',
    pagination: '分页',
  },
} as const;

export const ja = {
  list: {
    search: '検索',
    searchAccount: 'アカウントを検索…',
    searchRepo: 'リポジトリ名や名前空間を検索…',
    searchClaim: '問題を検索…',
    searchActor: '実行者や対象を検索…',
    all: 'すべて',
    allRepositories: 'すべてのリポジトリ',
    prev: '前へ',
    next: '次へ',
    range: '{total} 件中 {from}–{to}',
    empty: '一致する結果がありません。',
    reset: 'リセット',
    clearFilters: 'フィルターをクリア',
    total: '全 {total} 件',
    pagination: 'ページ移動',
  },
} as const;

export const ko = {
  list: {
    search: '검색',
    searchAccount: '계정 검색…',
    searchRepo: '네임스페이스나 저장소 이름 검색…',
    searchClaim: '문제 검색…',
    searchActor: '작업자나 대상 검색…',
    all: '전체',
    allRepositories: '모든 저장소',
    prev: '이전',
    next: '다음',
    range: '{total}개 중 {from}–{to}',
    empty: '일치하는 결과가 없습니다.',
    reset: '초기화',
    clearFilters: '필터 지우기',
    total: '총 {total}개',
    pagination: '페이지 이동',
  },
} as const;

/** Maintained separately from `zh`: vocabulary differs, not just glyphs. */
export const zhHant = {
  list: {
    search: '搜尋',
    searchAccount: '搜尋帳號…',
    searchRepo: '搜尋命名空間或儲存庫名稱…',
    searchClaim: '搜尋問題…',
    searchActor: '搜尋操作者 / 目標…',
    all: '全部',
    allRepositories: '全部儲存庫',
    prev: '上一頁',
    next: '下一頁',
    range: '{from}–{to} / 共 {total}',
    empty: '無相符結果。',
    reset: '重設',
    clearFilters: '清除篩選',
    total: '共 {total} 筆',
    pagination: '分頁',
  },
} as const;

export const fr = {
  list: {
    search: 'Rechercher',
    searchAccount: 'Rechercher un compte…',
    searchRepo: 'Rechercher un dépôt par nom ou espace de noms…',
    searchClaim: 'Rechercher un problème…',
    searchActor: 'Rechercher un auteur / une cible…',
    all: 'Tout',
    allRepositories: 'Tous les dépôts',
    prev: 'Précédent',
    next: 'Suivant',
    range: '{from}–{to} sur {total}',
    empty: 'Aucun résultat.',
    reset: 'Réinitialiser',
    clearFilters: 'Effacer les filtres',
    total: '{total} au total',
    pagination: 'Pagination',
  },
} as const;

export const de = {
  list: {
    search: 'Suchen',
    searchAccount: 'Konto suchen…',
    searchRepo: 'Repository nach Namespace oder Name suchen…',
    searchClaim: 'Problem suchen…',
    searchActor: 'Person / Ziel suchen…',
    all: 'Alle',
    allRepositories: 'Alle Repositories',
    prev: 'Zurück',
    next: 'Weiter',
    range: '{from}–{to} von {total}',
    empty: 'Keine passenden Ergebnisse.',
    reset: 'Zurücksetzen',
    clearFilters: 'Filter löschen',
    total: '{total} insgesamt',
    pagination: 'Seitennavigation',
  },
} as const;

export const pt = {
  list: {
    search: 'Pesquisar',
    searchAccount: 'Pesquisar conta…',
    searchRepo: 'Pesquisar namespace ou nome do repositório…',
    searchClaim: 'Pesquisar problema…',
    searchActor: 'Pesquisar pessoa / alvo…',
    all: 'Tudo',
    allRepositories: 'Todos os repositórios',
    prev: 'Anterior',
    next: 'Próximo',
    range: '{from}–{to} de {total}',
    empty: 'Nenhum resultado encontrado.',
    reset: 'Redefinir',
    clearFilters: 'Limpar filtros',
    total: '{total} no total',
    pagination: 'Paginação',
  },
} as const;

export const ru = {
  list: {
    search: 'Поиск',
    searchAccount: 'Поиск аккаунта…',
    searchRepo: 'Поиск по пространству имён или названию репозитория…',
    searchClaim: 'Поиск проблемы…',
    searchActor: 'Поиск автора / цели…',
    all: 'Все',
    allRepositories: 'Все репозитории',
    prev: 'Назад',
    next: 'Далее',
    range: '{from}–{to} из {total}',
    empty: 'Ничего не найдено.',
    reset: 'Сбросить',
    clearFilters: 'Очистить фильтры',
    total: 'всего {total}',
    pagination: 'Постраничная навигация',
  },
} as const;

export const es = {
  list: {
    search: 'Buscar',
    searchAccount: 'Buscar cuenta…',
    searchRepo: 'Buscar espacio de nombres o nombre del repositorio…',
    searchClaim: 'Buscar problema…',
    searchActor: 'Buscar autor / destino…',
    all: 'Todo',
    allRepositories: 'Todos los repositorios',
    prev: 'Anterior',
    next: 'Siguiente',
    range: '{from}–{to} de {total}',
    empty: 'No hay resultados.',
    reset: 'Restablecer',
    clearFilters: 'Borrar filtros',
    total: '{total} en total',
    pagination: 'Paginación',
  },
} as const;

export type CommonTranslation = typeof en;

// Review output languages: the single source of truth. Adding one also needs a locale directory
// in publisher and runner-supervisor.

/** Values are the `src/i18n/<locale>` directory names in each package. */
export const REVIEW_LANGUAGES = [
  'en',
  'zh',
  'zh-Hant',
  'ja',
  'ko',
  'es',
  'fr',
  'de',
  'pt',
  'ru',
] as const;

export type ReviewLanguage = (typeof REVIEW_LANGUAGES)[number];

const CANONICAL = new Map<string, ReviewLanguage>(
  REVIEW_LANGUAGES.map((l) => [l.toLowerCase(), l]),
);
const CHINESE_ALIASES = new Map<string, ReviewLanguage>([
  ['zh-cn', 'zh'],
  ['zh-sg', 'zh'],
  ['zh-hans', 'zh'],
  ['zh-tw', 'zh-Hant'],
  ['zh-hk', 'zh-Hant'],
  ['zh-mo', 'zh-Hant'],
]);

/**
 * Case-insensitive; unknown values fall back to `en`. Returns the canonical spelling because each
 * package's `isLocale()` matches directory names exactly (`zh-hant` would silently fall back to en).
 */
export function resolveReviewLanguage(input: string | undefined | null): ReviewLanguage {
  // Accept `_` as a separator too (`zh_CN`, `pt_BR`).
  const tag = input?.trim().toLowerCase().replace(/_/g, '-');
  if (!tag) return 'en';

  const exact = CANONICAL.get(tag);
  if (exact) return exact;

  // Region tags (`zh-CN`, `pt-BR`) are hand-written in `.winnowl.yaml` and must resolve. Chinese
  // splits by script: TW/HK/MO and Hant -> Traditional, other zh-* -> Simplified.
  if (tag.startsWith('zh-')) {
    const subtags = tag.split('-').slice(1);
    if (subtags.includes('hant')) return 'zh-Hant';
    if (subtags.includes('hans')) return 'zh';
    const region = subtags.find((part) => ['tw', 'hk', 'mo'].includes(part));
    if (region) return 'zh-Hant';
    return CHINESE_ALIASES.get(tag) ?? 'zh';
  }
  return CANONICAL.get(tag.split('-')[0] ?? '') ?? 'en';
}

/**
 * Unambiguous English language name for prompts: models misread bare locale codes
 * ("zh-Hant" often yields Simplified, "pt" is ambiguous).
 */
export const REVIEW_LANGUAGE_NAMES: Record<ReviewLanguage, string> = {
  en: 'English',
  zh: 'Simplified Chinese',
  'zh-Hant': 'Traditional Chinese (as written in Taiwan)',
  ja: 'Japanese',
  ko: 'Korean',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Brazilian Portuguese',
  ru: 'Russian',
};
