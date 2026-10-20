---
title: "Dependencies, symbols, and preludes"
description: "Черновой план страницы документации Arrival"
sidebar:
  order: 4
  badge:
    text: Draft
    variant: caution
---

> Редакционный черновик. Требует подготовки и проверки примеров перед публикацией.

## Задача страницы

Собирать расширения языка из переиспользуемых частей.

## План содержания

- deps, C3-порядок и дедупликация по идентичности.
- Конфликты имён и переопределение: показать реальное правило порядка.
- Когда использовать rosetta, native, define, defineSyntax и notImplemented.
- prelude и его время исполнения.
- Проверка свободных переменных Scheme-реализации и объявление зависимостей.

## Пример для подготовки

Базовая capability и зависящая от неё прикладная; затем diamond dependency с наблюдаемой инициализацией.

## Источники для проверки

- [packages/arrival/docs/environments.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/environments.md)
- [packages/arrival/src/common/capability.ts](https://github.com/here-build/arrival/blob/main/packages/arrival/src/common/capability.ts)
