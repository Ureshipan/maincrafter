export async function ollamaReply({ ollamaHost, model, system, user }) {
    const res = await fetch(`${ollamaHost}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
        model,
        stream: false,
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
        ]
        })
    })

    if (!res.ok) {
        const text = await res.text()
        throw new Error(`Ollama HTTP ${res.status}: ${text}`)
    }

    const json = await res.json()
    return json?.message?.content ?? ''
}
