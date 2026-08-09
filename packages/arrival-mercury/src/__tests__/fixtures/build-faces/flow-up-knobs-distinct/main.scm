(require "a/metric.scm")
(require "b/metric.scm")
(define/overridable threshold s/number 0)
(list threshold (a-t) (b-t))
