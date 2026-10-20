---
title: "Resources and disposal"
description: "Черновой план страницы документации Arrival"
sidebar:
  order: 3
  badge:
    text: Draft
    variant: caution
---

> Редакционный черновик. Требует подготовки и проверки примеров перед публикацией.

## Задача страницы

Объяснить владение ресурсами без утечек и преждевременного открытия.

## План содержания

- Публичная фабрика resources(config) => bag; фабрика синхронная.
- Ленивое получение bag, кэширование на RunContext и this.resources.
- Symbol.asyncDispose на bag и освобождение при disposal контекста.
- Разные RunContext получают разные ресурсы; разделяемый контекст сохраняет их.
- Не обещать автоматическое рекурсивное освобождение полей bag или Symbol.dispose.
- ResourceCell/Ref описать отдельно как более низкий уровень: single-flight, wind-down, повторное открытие.

## Пример для подготовки

Клиент с журналом open/use/close: нет обращений, одно обращение, повторные обращения, ошибка и явное завершение контекста. Показать, кто владеет disposal.

## Источники для проверки

- [packages/arrival/src/common/capability.ts](https://github.com/here-build/arrival/blob/main/packages/arrival/src/common/capability.ts)
- [packages/arrival/src/common/resources.ts](https://github.com/here-build/arrival/blob/main/packages/arrival/src/common/resources.ts)
- [packages/arrival/src/common/**tests**/run-scoped-resources.test.ts](https://github.com/here-build/arrival/blob/main/packages/arrival/src/common/__tests__/run-scoped-resources.test.ts)
