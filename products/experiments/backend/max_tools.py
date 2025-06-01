from typing import Any
from ee.hogai.tool import MaxTool
from pydantic import BaseModel, Field

from posthog.models.experiment import Experiment


class SearchExperimentsArgs(BaseModel):
    query: str = Field(
        description=(
            "Search query for experiments. Can be a name, partial name, or even empty string to list all experiments. "
            "Examples: 'sign-up', 'checkout', 'onboarding', or '' for all"
        )
    )


class SearchExperimentsTool(MaxTool):
    name: str = "search_experiments"
    description: str = (
        "Find and analyze experiments. "
        "Always use this tool first when the user mentions experiments, A/B tests, or feature flags with variants. "
        "This is the primary tool for any experiment-related questions."
    )
    args_schema: type[BaseModel] = SearchExperimentsArgs
    thinking_message: str = "Searching for experiments"
    root_system_prompt_template: str = """
IMPORTANT: When users ask about experiments, A/B tests, or mention specific experiment names, you MUST use the search_experiments tool FIRST, not create_and_query_insight.

Examples of when to use this tool:
- "How's my sign-up experiment doing?"
- "Show me my experiments"
- "What's the status of the checkout test?"
- "Are any experiments running?"
- Any mention of "experiment", "A/B test", "test", or "variant"

This tool finds experiments and returns their metadata. After using this tool, you may then use create_and_query_insight to analyze the specific metrics if needed.

Current experiments available: {current_experiments}
"""

    def _run_impl(self, query: str) -> tuple[str, Any]:
        try:
            if not self._team_id:
                return "No team context provided.", []

            experiments = (
                Experiment.objects.filter(team_id=self._team_id, name__icontains=query, deleted=False, archived=False)
                .order_by("-created_at")
                .values("id", "name", "description", "start_date", "end_date")
            )

            results = list(experiments)

            if not results:
                return f"No experiments found matching '{query}'.", []

            return (f"Found {len(results)} experiments matching '{query}'.", results)
        except Exception as e:
            # import structlog
            # logger = structlog.get_logger(__name__)
            # logger.error("search_experiments_error", error=str(e), team_id=self._team_id, query=query)
            return f"Error searching experiments: {str(e)}", []
