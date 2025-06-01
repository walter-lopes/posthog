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

        // Extract key metrics from results
        const results = metricResults?.[0]?.insight
        const probability = results?.probability // or whatever field contains win probability
        const winningVariant = results?.winning_variant
        const conversionDiff = results?.relative_difference // or conversion rate difference
        const isSignificant = results?.significant
        const daysRunning = experiment.start_date
            ? Math.floor((Date.now() - new Date(experiment.start_date).getTime()) / (1000 * 60 * 60 * 24))
            : 0
        const daysRemaining = experiment.end_date
            ? Math.max(0, Math.floor((new Date(experiment.end_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
            : null

        const prompt = `
            Write ONE concise sentence:
            ${
                isSignificant
                    ? `${winningVariant} variant has ${probability}% win probability with ${conversionDiff}% lift`
                    : `Experiment running ${daysRunning} days, ${
                          daysRemaining ? `${daysRemaining} days left` : 'ongoing'
                      }, no significant results yet`
            }

            Rewrite this as a natural sentence, max 15 words. Examples:
            - "Control winning with 95% probability (+12% conversion)"
            - "Too early, 8 days remaining"
            - "No clear winner after 14 days"
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
