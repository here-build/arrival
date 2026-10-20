---
title: "Configuration and optional features"
description: "Черновой план страницы документации Arrival"
sidebar:
  order: 2
  badge:
    text: Draft
    variant: caution
---

> Редакционный черновик. Требует подготовки и проверки примеров перед публикацией.

## Задача страницы

Показать работу capability в полном и частично настроенном окружении.

## План содержания

- Схемы конфигурации, optional, defaults и this.configuration.
- Отсутствующее обязательное значение, неверное значение и отключённая опциональная возможность — разные случаи.
- requiresConfig на отдельных символах, включая any-of группы.
- Функция остаётся известной; door сообщает владельца и недостающую настройку.
- Vocabulary.degraded для discovery и интерфейса настройки.
- Не описывать удалённый переключатель degradation; проверить defaults по коду и тестам.

## Пример для подготовки

Локальное форматирование работает всегда; загрузка требует клиента. Вторая демонстрация — require с fs или loader. Привести фактическую диагностику.

## Источники для проверки

- [packages/arrival/src/common/degradation.ts](https://github.com/here-build/arrival/blob/main/packages/arrival/src/common/degradation.ts)
- [packages/arrival/src/**tests**/laws/degradation.law.test.ts](https://github.com/here-build/arrival/blob/main/packages/arrival/src/__tests__/laws/degradation.law.test.ts)
- [packages/arrival-modules/README.md](https://github.com/here-build/arrival/blob/main/packages/arrival-modules/README.md)
