---
title: "Replay and deferred effects"
description: "Черновой план страницы документации Arrival"
sidebar:
  order: 5
  badge:
    text: Draft
    variant: caution
---

> Редакционный черновик. Требует подготовки и проверки примеров перед публикацией.

## Задача страницы

Объяснить воспроизведение и подготовку действий к исполнению.

## План содержания

- Record/replay на границе и повторный live-запуск.
- Какие вызовы обслуживаются записью, а какие могут исполняться снова согласно контракту.
- Отдельно объяснить provenance replay.
- Сбор sink-вызовов, порядок и проверка чтения после отложенной записи.
- Approval, атомарность, rollback и retries принадлежат хосту.

## Пример для подготовки

Сначала получить данные и собрать действия; показать журнал перед выполнением. Не называть это транзакцией.

## Источники для проверки

- [packages/arrival/docs/execution.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/execution.md)
- [packages/arrival/docs/PROVENANCE.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/PROVENANCE.md)
