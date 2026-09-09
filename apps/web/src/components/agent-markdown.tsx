import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

function normalizeSlackLinks(input: string): string {
  return input.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)");
}

const components: Components = {
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
};

export function AgentMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {normalizeSlackLinks(content)}
    </ReactMarkdown>
  );
}
