type AgentRuntime = {
  provider?: string | null
  model?: string | null
  thinkingLevel?: string | null
}

export function AgentRuntime({ agent }: { agent: AgentRuntime }) {
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
      {[
        ["Provider", agent.provider],
        ["Model", agent.model],
        ["Thinking level", agent.thinkingLevel],
      ].map(([label, value]) => (
        <div key={label} className="min-w-0 space-y-1">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="font-medium break-words">
            {value ?? "Not specified"}
          </dd>
        </div>
      ))}
    </dl>
  )
}
