from typing import Any
from ee.hogai.tool import MaxTool
from pydantic import BaseModel, Field
from django.forms.models import model_to_dict

from posthog.models.experiment import Experiment
from posthog.hogql_queries.experiments.experiment_exposures_query_runner import ExperimentExposuresQueryRunner
from posthog.schema import ExperimentEventExposureConfig, ExperimentExposureQuery


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

Your job is ONLY to search for and list the experiments matching the user's query.
DO NOT attempt to analyze, summarize, or speculate about any experiment's results or status.
DO NOT pick or recommend an experiment for analysis.
DO NOT proceed to the next step or use any other tool until the user explicitly asks for more information or analysis.

After listing the experiments, STOP and wait for the user's next prompt.

Examples of when to use this tool:
- "How's my sign-up experiment doing?"
- "Show me my experiments"
- "What's the status of the checkout test?"
- "Are any experiments running?"
- Any mention of "experiment", "A/B test", "test", or "variant"

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
            return f"Error searching experiments: {str(e)}", []


class AnalyzeExperimentArgs(BaseModel):
    experiment_id: int = Field(description="The ID of the experiment to analyze.")


class AnalyzeExperimentTool(MaxTool):
    name: str = "analyze_experiment"
    description: str = "Analyze the results of a selected experiment."
    args_schema: type[BaseModel] = AnalyzeExperimentArgs
    thinking_message: str = "Analyzing experiment"
    root_system_prompt_template: str = """
IMPORTANT: Only use the analyze_experiment tool after the user has selected a specific experiment (usually after using search_experiments).
This tool analyzes the results of the selected experiment, including exposures, conversions, and statistical significance.

DO NOT use this tool on your own. ONLY use this tool if the user requests analysis of the selected experiment.

Examples of when to use this tool:
- "Show me the results for experiment 123"
- "Analyze the onboarding experiment"
- "What happened in the checkout test?"

You must provide the experiment_id of the experiment to analyze.
"""
    def _run_impl(self, experiment_id: int) -> tuple[str, Any]:
        try:
            if not self._team_id:
                return "No team context provided.", []

            experiment = Experiment.objects.filter(team_id=self._team_id, id=experiment_id, deleted=False, archived=False).first()

            if not experiment:
                return f"No experiment found with ID {experiment_id}.", []

            query = ExperimentExposureQuery(
                kind="ExperimentExposureQuery",
                experiment_id=experiment.id,
                experiment_name=experiment.name,
                feature_flag=model_to_dict(experiment.feature_flag),
                holdout=model_to_dict(experiment.holdout) if experiment.holdout else None,
                start_date=experiment.start_date.isoformat() if experiment.start_date else None,
                end_date=experiment.end_date.isoformat() if experiment.end_date else None,
                exposure_criteria=experiment.exposure_criteria,
            )

            query_runner = ExperimentExposuresQueryRunner(
                team=experiment.team,
                query=query,
            )

            response = query_runner.calculate()

            if not response:
                return "No results available for this experiment yet.", []

            return "Here are the results of the experiment:", {
                "experiment": {
                    "id": experiment.id,
                    "name": experiment.name,
                    "description": experiment.description,
                    "parameters": experiment.parameters,
                    "exposure_criteria": experiment.exposure_criteria,
                    "start_date": experiment.start_date.isoformat() if experiment.start_date else None,
                    "end_date": experiment.end_date.isoformat() if experiment.end_date else None,
                },
                "results": response,
            }
        except Exception as e:
            return f"Error searching experiments: {str(e)}", []
