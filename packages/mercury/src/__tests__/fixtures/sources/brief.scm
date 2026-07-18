;; The minimal realistic shape: one prompt, called once, no loop, no
;; optimization — most Inhuman pipelines start here before growing into
;; something like gepa.scm. compile-project.test.ts's other fixture is the
;; complex end of the range; this is the simple end.
(define summarize (require "summarize.prompt"))
(summarize (list "the article") :text "the article")
