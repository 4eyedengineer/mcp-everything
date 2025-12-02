import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';

import {
  ValidationResult,
  WorkflowRunInfo,
  ToolValidationResult,
} from '../types/validation.types';

/**
 * GitHub Actions-based validator for MCP servers
 * Polls workflow run status and extracts test results
 */
@Injectable()
export class GitHubActionsValidatorProvider {
  private readonly logger = new Logger(GitHubActionsValidatorProvider.name);
  private readonly octokit: Octokit;

  constructor(private readonly configService: ConfigService) {
    const token = this.configService.get<string>('GITHUB_TOKEN');
    if (!token) {
      this.logger.warn('GITHUB_TOKEN not configured - GitHub Actions validation will not work');
    }
    this.octokit = new Octokit({ auth: token });
  }

  /**
   * Get the latest workflow run for a repository
   */
  async getLatestWorkflowRun(owner: string, repo: string): Promise<WorkflowRunInfo | null> {
    try {
      const { data } = await this.octokit.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        per_page: 1,
      });

      if (data.workflow_runs.length === 0) {
        return null;
      }

      const run = data.workflow_runs[0];
      return {
        id: run.id,
        status: run.status as WorkflowRunInfo['status'],
        conclusion: run.conclusion as WorkflowRunInfo['conclusion'],
        htmlUrl: run.html_url,
        createdAt: new Date(run.created_at),
        updatedAt: new Date(run.updated_at),
      };
    } catch (error) {
      this.logger.error(`Failed to get workflow runs: ${error.message}`);
      return null;
    }
  }

  /**
   * Get workflow run by ID
   */
  async getWorkflowRun(owner: string, repo: string, runId: number): Promise<WorkflowRunInfo | null> {
    try {
      const { data: run } = await this.octokit.actions.getWorkflowRun({
        owner,
        repo,
        run_id: runId,
      });

      return {
        id: run.id,
        status: run.status as WorkflowRunInfo['status'],
        conclusion: run.conclusion as WorkflowRunInfo['conclusion'],
        htmlUrl: run.html_url,
        createdAt: new Date(run.created_at),
        updatedAt: new Date(run.updated_at),
      };
    } catch (error) {
      this.logger.error(`Failed to get workflow run ${runId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Poll workflow run until completion or timeout
   */
  async pollWorkflowRun(
    owner: string,
    repo: string,
    runId: number,
    timeoutMs: number = 300000, // 5 minutes
    intervalMs: number = 10000, // 10 seconds
  ): Promise<WorkflowRunInfo | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const run = await this.getWorkflowRun(owner, repo, runId);
      if (!run) {
        return null;
      }

      if (run.status === 'completed') {
        return run;
      }

      this.logger.debug(`Workflow run ${runId} status: ${run.status}, waiting...`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    this.logger.warn(`Workflow run ${runId} did not complete within timeout`);
    return null;
  }

  /**
   * Extract test results from workflow run logs
   */
  async extractTestResults(owner: string, repo: string, runId: number): Promise<ValidationResult> {
    try {
      // Get workflow run info
      const run = await this.getWorkflowRun(owner, repo, runId);
      if (!run) {
        return {
          buildSuccess: false,
          buildError: 'Workflow run not found',
          toolResults: [],
          errors: ['Workflow run not found'],
          source: 'github_actions',
        };
      }

      // Get job logs
      const jobs = await this.getWorkflowJobs(owner, repo, runId);
      const toolResults = this.parseJobResults(jobs);

      // Determine overall success
      const buildSuccess = run.conclusion === 'success';
      const errors: string[] = [];

      if (!buildSuccess) {
        errors.push(`Workflow conclusion: ${run.conclusion}`);
      }

      // Check for specific failures in jobs
      for (const job of jobs) {
        if (job.conclusion !== 'success') {
          errors.push(`Job "${job.name}" failed: ${job.conclusion}`);
        }
      }

      return {
        buildSuccess,
        toolResults,
        errors: errors.length > 0 ? errors : undefined,
        source: 'github_actions',
      };
    } catch (error) {
      this.logger.error(`Failed to extract test results: ${error.message}`);
      return {
        buildSuccess: false,
        buildError: error.message,
        toolResults: [],
        errors: [error.message],
        source: 'github_actions',
      };
    }
  }

  /**
   * Get workflow jobs
   */
  private async getWorkflowJobs(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<Array<{ name: string; conclusion: string | null; steps: Array<{ name: string; conclusion: string | null }> }>> {
    try {
      const { data } = await this.octokit.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id: runId,
      });

      return data.jobs.map((job) => ({
        name: job.name,
        conclusion: job.conclusion,
        steps: (job.steps || []).map((step) => ({
          name: step.name,
          conclusion: step.conclusion || null,
        })),
      }));
    } catch (error) {
      this.logger.error(`Failed to get workflow jobs: ${error.message}`);
      return [];
    }
  }

  /**
   * Parse job results to extract tool test results
   */
  private parseJobResults(
    jobs: Array<{ name: string; conclusion: string | null; steps: Array<{ name: string; conclusion: string | null }> }>,
  ): ToolValidationResult[] {
    const results: ToolValidationResult[] = [];

    for (const job of jobs) {
      // Look for test steps
      for (const step of job.steps) {
        // Check if this is a test step
        if (step.name.toLowerCase().includes('test') || step.name.toLowerCase().includes('validate')) {
          results.push({
            toolName: step.name,
            success: step.conclusion === 'success',
            error: step.conclusion !== 'success' ? `Step failed: ${step.conclusion}` : undefined,
            executionTime: 0, // Not available from API
          });
        }
      }
    }

    // If no specific test steps found, create a summary result
    if (results.length === 0) {
      for (const job of jobs) {
        results.push({
          toolName: job.name,
          success: job.conclusion === 'success',
          error: job.conclusion !== 'success' ? `Job failed: ${job.conclusion}` : undefined,
          executionTime: 0,
        });
      }
    }

    return results;
  }

  /**
   * Parse repository URL to extract owner and repo
   */
  parseRepositoryUrl(url: string): { owner: string; repo: string } | null {
    // Handle GitHub URLs
    const patterns = [
      /github\.com\/([^/]+)\/([^/]+)/,
      /github\.com:([^/]+)\/([^/]+)/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return {
          owner: match[1],
          repo: match[2].replace(/\.git$/, ''),
        };
      }
    }

    return null;
  }

  /**
   * Validate a deployed repository via GitHub Actions
   */
  async validateRepository(repositoryUrl: string): Promise<ValidationResult> {
    const parsed = this.parseRepositoryUrl(repositoryUrl);
    if (!parsed) {
      return {
        buildSuccess: false,
        buildError: 'Invalid repository URL',
        toolResults: [],
        errors: ['Could not parse repository URL'],
        source: 'github_actions',
      };
    }

    const { owner, repo } = parsed;

    // Get latest workflow run
    const latestRun = await this.getLatestWorkflowRun(owner, repo);
    if (!latestRun) {
      return {
        buildSuccess: false,
        buildError: 'No workflow runs found',
        toolResults: [],
        errors: ['No GitHub Actions workflow runs found for this repository'],
        source: 'github_actions',
      };
    }

    // If still running, poll for completion
    let run = latestRun;
    if (run.status !== 'completed') {
      const completedRun = await this.pollWorkflowRun(owner, repo, run.id);
      if (completedRun) {
        run = completedRun;
      } else {
        return {
          buildSuccess: false,
          buildError: 'Workflow run timed out',
          toolResults: [],
          errors: ['GitHub Actions workflow did not complete in time'],
          source: 'github_actions',
        };
      }
    }

    // Extract results
    return this.extractTestResults(owner, repo, run.id);
  }
}
