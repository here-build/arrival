import type { Meta, StoryObj } from "@storybook/react-vite";

import { type LiveProps, LiveExecutionGraph, liveArgTypes, liveDecorator } from "./__fixtures__/live.js";
import { workflowPack } from "./__fixtures__/workflow.js";

/**
 * Agent pipelines over a harness's verbs — `agent/ask|call`, `bot/ask|call`, `user/ask`,
 * `mcp/tool` (Gmail / GitHub / Slack tool names), `meta-reactivity/added|removed`, `self/notify`
 * — each a real arrival program against the mock world in `__fixtures__/workflow.ts`. Each story
 * owns a world, so "Run again" sees a grown inbox, a smaller diff and bots that remember.
 */
const meta: Meta<typeof LiveExecutionGraph> = {
  title: "Execution Graph/Workflows",
  component: LiveExecutionGraph,
  args: { mode: "actual", tick: 300 },
  argTypes: liveArgTypes,
  decorators: [liveDecorator],
  excludeStories: ["WORKFLOW_PROGRAMS"],
};
export default meta;

type Story = StoryObj<typeof LiveExecutionGraph>;

/** A story over its own world (kept out of `args`: Storybook would clone it per render). */
function workflow(program: string, extra: Partial<LiveProps> = {}): Story {
  const pack = workflowPack();
  return { args: { program, ...extra }, render: (args) => <LiveExecutionGraph {...args} pack={pack} /> };
}

export const WORKFLOW_PROGRAMS = {
  /** New unread threads only (the diff against the last run), classified, then routed three ways.
   *  Run again: one new thread arrives, so the fan has one track. */
  InboxTriage: `(define inbox (:threads (mcp/tool "gmail" "search_threads" :query "in:inbox is:unread newer_than:1d" :pageSize 20)))
(define fresh (meta-reactivity/added :identity :id inbox))
(map (lambda (thread)
       (let ((verdict (agent/ask "triage" (:subject thread))))
         (cond ((equal? (:category verdict) "bug")
                (mcp/tool "github" "create_issue" :owner "acme" :repo "app"
                          :title (:subject thread) :body (:summary verdict) :labels (list "from-inbox")))
               ((equal? (:category verdict) "question")
                (if (equal? (user/ask (string-append "Send a drafted reply to " (:sender thread) "?")) "yes, send it")
                    (mcp/tool "gmail" "create_draft" :to (list (:sender thread))
                              :subject (string-append "Re: " (:subject thread))
                              :body (agent/ask "drafter" (:subject thread)))
                    "skipped"))
               (else
                (mcp/tool "slack" "slack_post_message" :channel_id "C04FYI"
                          :text (string-append "FYI from " (:sender thread) ": " (:subject thread)))))))
     fresh)`,

  /** Non-draft PRs, each reviewed by three lenses in parallel, a lead's verdict, then the review. */
  PullRequestReviewSwarm: `(define ready
  (filter (lambda (pr) (not (:draft pr)))
          (mcp/tool "github" "list_pull_requests" :owner "acme" :repo "app" :state "open")))
(map (lambda (pr)
       (let* ((files (mcp/tool "github" "get_pull_request_files" :owner "acme" :repo "app" :pullNumber (:number pr)))
              (brief (string-append (:title pr) " (" (number->string (length files)) " files)"))
              (reviews (map (lambda (lens) (agent/ask lens brief)) (list "security" "performance" "api-design")))
              (verdict (agent/ask "lead-reviewer" (apply string-append (map (lambda (r) (:verdict r)) reviews)))))
         (self/notify (string-append "#" (number->string (:number pr)) ": " verdict))
         (cond
           ((equal? verdict "approve")
            (mcp/tool "github" "create_pull_request_review" :owner "acme" :repo "app" :pullNumber (:number pr)
                      :event "APPROVE" :body "LGTM from all three lenses"))
           ((equal? verdict "request-changes")
            (mcp/tool "github" "create_pull_request_review" :owner "acme" :repo "app" :pullNumber (:number pr)
                      :event "REQUEST_CHANGES" :body (:note (car reviews))))
           (else (self/notify "lead reviewer abstained")))))
     ready)`,

  /** Read the alert channel, diagnose, file an issue (the infra repo refuses: the guard falls back
   *  to Slack), then poll the on-call bot until it reports resolved. */
  IncidentResponse: String.raw`(define alerts (:messages (mcp/tool "slack" "slack_get_channel_history" :channel_id "C02ALERTS" :limit 20)))
(define diagnosis (agent/ask "sre" (reduce (lambda (m log) (string-append log (:text m) "\n")) "" alerts)))
(define ticket
  (guard (e (#t (mcp/tool "slack" "slack_post_message" :channel_id "C02INCIDENT"
                          :text (string-append "Could not file an issue; tracking here: " (:cause diagnosis)))))
    (mcp/tool "github" "create_issue" :owner "acme" :repo "infra"
              :title (string-append "[" (:severity diagnosis) "] " (:cause diagnosis)))))
(let poll ((round 1) (status (bot/ask "oncall" (:action diagnosis))))
  (if (or (equal? status "resolved") (> round 4))
      (mcp/tool "slack" "slack_reply_to_thread" :channel_id "C02ALERTS" :thread_ts (:ts (car alerts))
                :text (string-append "Resolved after " (number->string round) " check-ins"))
      (poll (+ round 1) (bot/ask "oncall" (string-append "status after check-in " (number->string round))))))`,

  /** A standing release bot asked three questions in turn, a human go/no-go, then a void-accepting
   *  call. The bot remembers: on the second run the blocker is gone and the release ships. */
  ReleaseStandup: String.raw`(define answers
  (do ((questions (list "Any blockers for the release?" "What version are we cutting?" "Draft the changelog")
                  (cdr questions))
       (heard (list) (cons (bot/ask "release-captain" (car questions)) heard)))
      ((null? questions) (reverse heard))))
(define go (user/ask (string-append "Ship " (cadr answers) "? Blockers: " (car answers))))
(if (equal? go "ship")
    (begin
      (bot/call "release-captain" "ship it")
      (mcp/tool "slack" "slack_post_message" :channel_id "C01RELEASE"
                :text (string-append "Releasing " (cadr answers) "\n" (caddr answers))))
    (bot/call "release-captain" (string-append "holding the release: " (car answers))))`,

  /** Multi-step elicitation: re-ask until the email is a work address, three more questions, then
   *  provision by role and welcome. */
  OnboardingWizard: String.raw`(define email
  (let ask-again ((prompt "What's your work email?"))
    (let ((answer (user/ask prompt)))
      (if (string-suffix? "@acme.com" answer)
          answer
          (ask-again (string-append "\"" answer "\" is not an @acme.com address. What's your work email?"))))))
(define role (user/ask "What's your role? (engineer / designer / sales)"))
(define team (user/ask "Which team are you joining?"))
(define start (user/ask "Start date (YYYY-MM-DD)?"))
(cond
  ((equal? role "engineer")
   (map (lambda (repo) (agent/call "provisioner" (string-append "grant " email " write on acme/" repo)))
        (list "app" "infra" "design-system")))
  ((equal? role "designer") (agent/call "provisioner" (string-append "grant " email " a Figma editor seat")))
  (else (agent/call "provisioner" (string-append "grant " email " a CRM seat"))))
(mcp/tool "slack" "slack_post_message" :channel_id "C00WELCOME"
          :text (string-append "Welcome " email " to " team ", starting " start))
(mcp/tool "gmail" "create_draft" :to (list email) :subject "Welcome to Acme"
          :body (agent/ask "drafter" (string-append "a welcome note for the " team " team")))`,

  /** Three sources gathered in parallel, each summarized; issues closed since the last digest
   *  (the `removed` diff) appended; folded into one draft. */
  WeeklyDigest: String.raw`(define open-issues (mcp/tool "github" "list_issues" :owner "acme" :repo "app" :state "open"))
(define closed (meta-reactivity/removed :identity :number open-issues))
(define sections
  (map (lambda (source)
         (case source
           ((inbox)
            (map (lambda (t) (:subject t))
                 (:threads (mcp/tool "gmail" "search_threads" :query "label:customers newer_than:7d"))))
           ((pulls)
            (map (lambda (pr) (:title pr))
                 (mcp/tool "github" "list_pull_requests" :owner "acme" :repo "app" :state "closed")))
           (else
            (map (lambda (m) (:text m))
                 (:messages (mcp/tool "slack" "slack_get_channel_history" :channel_id "C03ANNOUNCE" :limit 50))))))
       (list 'inbox 'pulls 'announcements)))
(define notes
  (map (lambda (lines) (agent/ask "summarizer" (reduce (lambda (line acc) (string-append acc line "; ")) "" lines)))
       sections))
(define digest
  (reduce (lambda (line acc) (string-append acc "\n" line))
          ""
          (append notes
                  (map (lambda (issue) (string-append "Closed #" (number->string (:number issue)) ": " (:title issue)))
                       closed))))
(self/notify "weekly digest drafted")
(mcp/tool "gmail" "create_draft" :to (list "team@acme.com") :subject "Weekly digest"
          :body (agent/ask "editor" digest))`,

  /** Rerun a red CI run up to twice; each attempt reads every suspect's logs in parallel and keeps
   *  only the ones a doctor calls flaky, notifying the session per job. */
  FlakyTestHunt: String.raw`(define run-id
  (:id (car (:workflow_runs (mcp/tool "github" "list_workflow_runs" :owner "acme" :repo "app"
                                      :workflow_id "ci.yml" :status "failure")))))
(define failing (:jobs (mcp/tool "github" "list_workflow_jobs" :owner "acme" :repo "app" :run_id run-id :filter "latest")))
(do ((attempt 1 (+ attempt 1))
     (suspects failing
               (filter (lambda (job)
                         (let ((logs (mcp/tool "github" "get_job_logs" :owner "acme" :repo "app" :job_id (:id job))))
                           (self/notify (string-append "attempt " (number->string attempt) ": " (:name job)))
                           (equal? (agent/ask "flake-doctor" (string-append (:name job) "\n" (:logs logs))) "flaky")))
                       suspects)))
    ((or (null? suspects) (> attempt 2))
     (mcp/tool "slack" "slack_post_message" :channel_id "C05CI"
               :text (string-append (number->string (length suspects)) " tests still flaky after "
                                    (number->string (- attempt 1)) " reruns")))
  (mcp/tool "github" "rerun_failed_jobs" :owner "acme" :repo "app" :run_id run-id))`,
};

export const InboxTriage: Story = workflow(WORKFLOW_PROGRAMS.InboxTriage);
export const PullRequestReviewSwarm: Story = workflow(WORKFLOW_PROGRAMS.PullRequestReviewSwarm);
export const IncidentResponse: Story = workflow(WORKFLOW_PROGRAMS.IncidentResponse);
export const ReleaseStandup: Story = workflow(WORKFLOW_PROGRAMS.ReleaseStandup);
export const OnboardingWizard: Story = workflow(WORKFLOW_PROGRAMS.OnboardingWizard);
export const WeeklyDigest: Story = workflow(WORKFLOW_PROGRAMS.WeeklyDigest);
export const FlakyTestHunt: Story = workflow(WORKFLOW_PROGRAMS.FlakyTestHunt, { tick: 200 });
