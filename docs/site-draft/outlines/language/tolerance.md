---
title: "Tolerance and compatibility"
description: "Черновой план страницы документации Arrival"
sidebar:
  order: 3
  badge:
    text: Draft
    variant: caution
---

> Редакционный черновик. Требует подготовки и проверки примеров перед публикацией.

## Задача страницы

Объяснить, какие привычки других диалектов Arrival принимает и где проходит граница.

## План содержания

- Развести заимствования синтаксиса, совместимые имена и nil-tolerance.
- Предпочтительная форма для нового кода и принимаемые альтернативы.
- Что конкретно меняет strict, а что сохраняется.
- Неожиданные различия: truthiness, отсутствующие ключи, порядок аргументов.
- Неподдерживаемые конструкции и объясняющие их doors.

## Пример для подготовки

Таблица: намерение → привычная форма → поведение Arrival → рекомендуемая форма; опираться на reader/runtime tests.

## Источники для проверки

- [packages/arrival/docs/llm-language-guide.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/llm-language-guide.md)
- [packages/arrival/docs/grammar.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/grammar.md)
