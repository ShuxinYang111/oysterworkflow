import type { AppLanguage } from "./app-language";
import type { OpenClawSkillReference } from "../../src/types/contracts.js";

const copy = {
  en: { title: "References", open: "Open reference" },
  zh: { title: "参考资料", open: "打开参考链接" },
} as const;

/**
 * EN: Renders only the References bound to the selected workflow node.
 * 中文: 只展示绑定到当前工作流节点的参考资料。
 * @param props node-bound References and current language.
 * @returns compact inspector section, or null when the node has no References.
 */
export function WorkflowNodeReferences({
  references,
  language,
}: {
  references: OpenClawSkillReference[];
  language: AppLanguage;
}) {
  if (references.length === 0) return null;
  const text = copy[language];
  return (
    <section
      className="workflow-graph-inspector-section workflow-node-references"
      aria-labelledby="workflow-node-references-title"
    >
      <h5 id="workflow-node-references-title">{text.title}</h5>
      <dl>
        {references.map((reference) => {
          const value = formatReferenceValue(reference.value);
          const url = referenceUrl(reference.value);
          return (
            <div key={reference.id}>
              <dt>{reference.name}</dt>
              <dd>
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer">
                    <span>{value}</span>
                    <small>{text.open}</small>
                  </a>
                ) : (
                  <p>{value}</p>
                )}
                {reference.notes ? <small>{reference.notes}</small> : null}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function formatReferenceValue(value: OpenClawSkillReference["value"]): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join("\n");
  return Object.entries(value)
    .map(([label, item]) => `${label}: ${item}`)
    .join("\n");
}

function referenceUrl(value: OpenClawSkillReference["value"]): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
