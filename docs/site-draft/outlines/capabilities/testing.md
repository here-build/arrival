---
title: "Testing a capability"
description: "Черновой план страницы документации Arrival"
sidebar:
  order: 6
  badge:
    text: Draft
    variant: caution
---

> Редакционный черновик. Требует подготовки и проверки примеров перед публикацией.

## Задача страницы

Проверять публичное поведение расширения.

## План содержания

- Минимальные fixtures через публичный exec/execState.
- Правильные и неправильные аргументы и результаты.
- Полная, частичная и неверная конфигурация.
- Создание и освобождение ресурсов.
- Зависимости, provenance и эффектный журнал для соответствующих контрактов.

## Пример для подготовки

Небольшая тестовая capability с локальным журналом; проверки поведения вместо внутренних полей.

## Источники для проверки

- [packages/arrival/docs/writing-capabilities.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/writing-capabilities.md)
- [packages/arrival/src/common/**tests**/run-scoped-resources.test.ts](https://github.com/here-build/arrival/blob/main/packages/arrival/src/common/__tests__/run-scoped-resources.test.ts)
