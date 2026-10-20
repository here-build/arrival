---
title: "Provenance"
description: "Черновой план страницы документации Arrival"
sidebar:
  order: 1
  badge:
    text: Draft
    variant: caution
---

> Редакционный черновик. Требует подготовки и проверки примеров перед публикацией.

## Задача страницы

Ответить на вопрос: откуда взялось это значение?

## План содержания

- Включить EvalTrace явно; без наблюдения история не записывается.
- Источник, преобразование и составной результат.
- Исследовать происхождение выбранного поля.
- Различать происхождение данных и более широкие зависимости вычисления; точную семантику запросов проверить по реализации.
- Capture в core и анализ в arrival-provenance.

## Пример для подготовки

Два источника и сводка, у которой разные поля имеют разные источники. Показать источник добавленного литерала честно.

## Источники для проверки

- [packages/arrival/README.md](https://github.com/here-build/arrival/blob/main/packages/arrival/README.md)
- [packages/arrival-provenance/README.md](https://github.com/here-build/arrival/blob/main/packages/arrival-provenance/README.md)
- [packages/arrival/docs/PROVENANCE.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/PROVENANCE.md)
