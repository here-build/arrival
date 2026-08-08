# Arrival-Scheme (agent card)

Sandboxed **R7RS-small Scheme**. No IO, no mutation.
Write **prefix s-expressions**.

## Maps

```scheme
(dict :id 1 :status "open")
(:status row)
(assoc-in u (list :profile :name) "Ada")
```

**Missing key → `nil` (= `'()`).** Only `#f` is false — `nil` is truthy.

```scheme
;; defaults: null?, never (if x x d) or (or x d)
(if (null? (:timeout cfg)) 30 (:timeout cfg))
```

## Pipelines & lists

```scheme
(take xs n)                        ; list first (not Clojure (take n xs))
(sort nums >)                      ; native < > = only — project dict fields first
(frequencies (map :kind items))    ; count-by-key
(str "x=" n)  (join ", " names)    ; sep-first on join
```

```scheme
;; good — sort a field
(let* ((xs (filter (lambda (e) (equal? (:kind e) "click")) events))
       (ns (sort (map :n xs) >)))
  (take ns 2))
;; bad  (sort xs (lambda (a b) (> (:n a) (:n b))))
;; bad  (take 2 xs)   ·   (reduce … (dict) xs) for counts
```

## Control

**`let*`** when a later init needs an earlier binding (`let` is parallel).
Return **one** value (list, vector, or dict).

## Do not use

`set!` · mutators · `nil?` (use `null?`)
