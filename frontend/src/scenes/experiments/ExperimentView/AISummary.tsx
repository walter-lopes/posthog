import { IconSparkles } from '@posthog/icons'
import { LemonButton, LemonSkeleton } from '@posthog/lemon-ui'
import { useActions, useValues } from 'kea'
import api from 'lib/api'
import { uuid } from 'lib/utils'
import { useEffect, useRef, useState } from 'react'
import { maxLogic } from 'scenes/max/maxLogic'
import { sidePanelLogic } from '~/layout/navigation-3000/sidepanel/sidePanelLogic'
import { SidePanelTab } from '~/types'
import { experimentLogic } from '../experimentLogic'
import { getExperimentStatus } from '../experimentsLogic'

export function AISummary(): JSX.Element {
    const { experiment, metricResults } = useValues(experimentLogic)
    const { openSidePanel } = useActions(sidePanelLogic)
    const { setQuestion } = useActions(maxLogic)

    const [summary, setSummary] = useState<string>('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(false)
    const abortControllerRef = useRef<AbortController | null>(null)

    const generateSummary = async () => {
        // Cancel any existing request
        if (abortControllerRef.current) {
            abortControllerRef.current.abort()
        }

        setLoading(true)
        setError(false)

        const result = metricResults?.[0]
        const variants = result?.variants || []
        const probability = result?.probability // { control: number, test: number }
        const isSignificant = result?.significant
        const significanceCode = result?.significance_code
        const pValue = result?.p_value
        const credibleIntervals = result?.credible_intervals // { control: [low, high], test: [low, high] }
        let winningVariant: string | null = null
        let lift: string | null = null

        if (probability && variants.length > 1) {
            // Find the variant with the highest probability
            const winner = Object.entries(probability).reduce((a, b) => (a[1] > b[1] ? a : b))
            winningVariant = winner[0]
            // Calculate lift as difference in success rates (or use credible intervals if you want)
            const control = variants.find((v: any) => v.key === 'control')
            const test = variants.find((v: any) => v.key !== 'control')
            if (control && test) {
                const controlRate = control.success_count / (control.success_count + control.failure_count)
                const testRate = test.success_count / (test.success_count + test.failure_count)
                lift = ((testRate - controlRate) * 100).toFixed(1)
            }
        }

        const daysRunning = experiment.start_date
            ? Math.floor((Date.now() - new Date(experiment.start_date).getTime()) / (1000 * 60 * 60 * 24))
            : 0
        const daysRemaining = experiment.end_date
            ? Math.max(0, Math.floor((new Date(experiment.end_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
            : null

        /**
         * this has to be use a backend tool. We need to figure out this...
         */
        const prompt = `
You are an expert product analyst. Write a short, clear summary (2-4 sentences) of the current state of the experiment "${
            experiment.name
        }". Provide a bit of analysis, not just a single line.

Experiment details:
- Name: ${experiment.name}
- Status: ${getExperimentStatus(experiment)}
- Days running: ${daysRunning}
${daysRemaining !== null ? `- Days remaining: ${daysRemaining}` : ''}
- Variants: ${variants.map((v: any) => v.key).join(', ')}
- P-value: ${pValue !== undefined ? pValue : 'N/A'}

Results:
${variants
    .map(
        (v: any) =>
            `- ${v.key}: ${v.success_count} conversions, ${v.failure_count} non-conversions, credible interval: [${
                credibleIntervals?.[v.key]?.[0]?.toFixed(3) ?? 'N/A'
            }, ${credibleIntervals?.[v.key]?.[1]?.toFixed(3) ?? 'N/A'}], probability of being best: ${
                probability?.[v.key] !== undefined ? (probability[v.key] * 100).toFixed(1) + '%' : 'N/A'
            }`
    )
    .join('\n')}

${
    isSignificant && winningVariant
        ? `- Winner: ${winningVariant} (win probability: ${(probability?.[winningVariant] * 100).toFixed(
              1
          )}%, lift: ${lift}%)`
        : '- No statistically significant winner yet.'
}

Instructions:
- If there is a significant winner, mention the variant, win probability, lift, and what this means for the experiment.
- If not, mention how long the experiment has been running, how much time is left, and whether the results are trending toward significance or if more data is needed.
- Comment on the relative performance of the variants, even if not significant, and mention the credible intervals and p-value if relevant.
- Do NOT speculate or invent results that are not in the data.
- Write as a product analyst would, not as an AI. Use clear, professional language.

Examples:
- "After 14 days, the test variant is leading with a 95% probability of being the best, showing a 12% lift over control. This result is statistically significant and suggests the test variant is outperforming the baseline."
- "The experiment has been running for 8 days with no significant difference between variants. More data is needed to draw a conclusion."
- "Control and test variants are performing similarly so far, with the test variant showing a slight, but not significant, improvement. Credible intervals overlap and the p-value is above the significance threshold."
`

        try {
            abortControllerRef.current = new AbortController()

            const response = await api.conversations.stream(
                {
                    content: prompt,
                    contextual_tools: {},
                    trace_id: uuid(),
                },
                {
                    signal: abortControllerRef.current.signal,
                }
            )

            const reader = response.body?.getReader()
            if (!reader) {
                throw new Error('No reader available')
            }

            const decoder = new TextDecoder()

            while (true) {
                const { done, value } = await reader.read()
                if (done) break

                const chunk = decoder.decode(value)
                // Parse SSE data
                const lines = chunk.split('\n')
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6))
                            if (data.type == 'ai' && data.content) {
                                setSummary(data.content)
                            }
                        } catch (e) {
                            // Ignore parsing errors
                        }
                    }
                }
            }
        } catch (e: any) {
            if (e.name !== 'AbortError') {
                console.error('Failed to generate summary:', e)
                setError(true)
            }
        } finally {
            setLoading(false)
            abortControllerRef.current = null
        }
    }

    useEffect(() => {
        if (experiment.start_date && metricResults?.[0]) {
            generateSummary()
        }

        return () => {
            // Cleanup on unmount
            if (abortControllerRef.current) {
                abortControllerRef.current.abort()
            }
        }
    }, [experiment.id, experiment.start_date, metricResults?.[0]?.last_refresh])

    if (!experiment.start_date) {
        return <></>
    }

    return (
        <div className="bg-bg-3000 border rounded p-3 mt-3">
            <div className="flex items-start gap-2">
                <IconSparkles className="text-lg mt-0.5" />
                <div className="flex-1">
                    <div className="font-semibold text-sm mb-1">AI Summary</div>
                    {loading ? (
                        <div className="space-y-1">
                            <LemonSkeleton className="h-4 w-full" />
                            <LemonSkeleton className="h-4 w-3/4" />
                        </div>
                    ) : error ? (
                        <div className="text-sm text-danger">
                            Failed to generate summary.
                            <LemonButton size="xsmall" type="tertiary" onClick={generateSummary} className="ml-2">
                                Retry
                            </LemonButton>
                        </div>
                    ) : (
                        <div className="text-sm text-muted">{summary || 'Generating summary...'}</div>
                    )}
                </div>
                <LemonButton
                    size="xsmall"
                    type="tertiary"
                    onClick={() => {
                        setQuestion(`Tell me more about the "${experiment.name}" experiment results`)
                        openSidePanel(SidePanelTab.Max)
                    }}
                    tooltip="Ask Max for more details"
                >
                    Ask Max
                </LemonButton>
            </div>
        </div>
    )
}
