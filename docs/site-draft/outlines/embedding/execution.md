---
title: "Execution and sessions"
description: "Черновой план страницы документации Arrival"
sidebar:
  order: 1
  badge:
    text: Draft
    variant: caution
---

> Редакционный черновик. Требует подготовки и проверки примеров перед публикацией.

## Задача страницы

Дать интегратору явную модель времени жизни.

## План содержания

- exec и execState, значения и состояние.
- Свежий scope и повторное использование LexicalScope.
- Scope и RunContext: разные объекты с разными обязанностями.
- Capabilities на вызов и определения в scope.
- Владение RunContext и его освобождение; проверить поведение каждого примера по публичному API.

## Пример для подготовки

Два рецепта: изолированные вызовы и продолжаемая сессия. Показать, какие данные переживают следующий вызов.

## Источники для проверки

- [packages/arrival/docs/execution.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/execution.md)
- [packages/arrival/src/eval/generator-exec.ts](https://github.com/here-build/arrival/blob/main/packages/arrival/src/eval/generator-exec.ts)
