---
title: "Validation, cancellation, and budgets"
description: "Черновой план страницы документации Arrival"
sidebar:
  order: 4
  badge:
    text: Draft
    variant: caution
---

> Редакционный черновик. Требует подготовки и проверки примеров перед публикацией.

## Задача страницы

Управлять исполнением и объяснять остановки.

## План содержания

- staticValidation: on/off, область проверки и ограничения require.
- signal и budgetMs: какие участки они могут прервать.
- Число tool calls — отдельный лимит хоста.
- Политика продолжения после ошибки: пример harness и отличие от одного exec.
- Отмена внутренних операций и судьба состояния.

## Пример для подготовки

Медленный отменяемый инструмент и программа с диагностируемой до запуска ошибкой.

## Источники для проверки

- [packages/arrival/docs/execution.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/execution.md)
- [packages/arrival/src/static-validation/validate-program.ts](https://github.com/here-build/arrival/blob/main/packages/arrival/src/static-validation/validate-program.ts)
