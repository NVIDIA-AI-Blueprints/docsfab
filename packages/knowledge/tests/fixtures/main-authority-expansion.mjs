/**
 * Verbatim copy of the authority-expansion guard on main (9a66aa648; unchanged
 * at c389c42b5). The property test compares the head decision with it.
 * Do not edit; replace only by copying main again.
 */
const PUBLICATION_ACTION = "(?:commit|push|publish|open\\s+(?:a|an)\\s+(?:MR|PR|merge\\s+request|pull\\s+request))";
const EXPLICIT_PUBLICATION_PROHIBITION = new RegExp(
  `(^|[;.!:]\\s*)(?:do not|never|must not|may not)\\s+${PUBLICATION_ACTION}(?:\\s*(?:,\\s*(?:(?:and|or)\\s+)?|(?:and|or)\\s+)${PUBLICATION_ACTION})*\\s*(?=[.!;]|$)`,
  "giu",
);

function authorityExpansion(item) {
  const condition = item.origin === "explicit"
    ? item.condition.replace(EXPLICIT_PUBLICATION_PROHIBITION, "$1")
    : item.condition;
  return /\b(?:approve|permission|add another target|change the workflow|publish)\b/iu.test(condition);
}

export { authorityExpansion as mainAuthorityExpansion };
