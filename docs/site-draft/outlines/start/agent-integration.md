---
title: "Your first agent integration"
description: "Черновой план страницы документации Arrival"
sidebar:
  order: 3
  badge:
    text: Draft
    variant: caution
---

> Редакционный черновик. Требует подготовки и проверки примеров перед публикацией.

## Задача страницы

Показать полный цикл между моделью, Arrival и хостом.

## План содержания

- Схема внешнего инструмента: аргумент с программой.
- Короткая инструкция модели и каталог доступного окружения.
- Привязка инструментов к capabilities; выполнение программы.
- Возврат значений и исходной диагностической информации модели; следующая исправленная попытка.
- Явно выбрать lifetime scope, политику ошибок и ограничения.
- Продолжение tutorial: подключить provenance и uneval.

## Пример для подготовки

Запрос → описание среды → программа с одной ошибкой → диагностика → исправленная программа → ответ. Минимальный provider-neutral адаптер; реальные API провайдеров описывать отдельно.

## Источники для проверки

- [packages/arrival/docs/llm-agent-card.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/llm-agent-card.md)
- [packages/arrival/docs/writing-capabilities.md](https://github.com/here-build/arrival/blob/main/packages/arrival/docs/writing-capabilities.md)
