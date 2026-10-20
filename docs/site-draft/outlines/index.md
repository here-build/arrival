---
title: Arrival
description: A language built for AI agents, with actionable errors and inspectable results.
template: splash
hero:
  tagline: The first language built for AI. Finally built for AI.
  actions:
    - text: Start here
      link: /start/overview/
      icon: right-arrow
    - text: Build a capability
      link: /capabilities/overview/
      variant: minimal
---

Arrival — встраиваемый Scheme для агентных вычислений: модель составляет программы из доступных инструментов, а хост управляет их исполнением.

:::note[Документация в разработке]
Сайт пока содержит черновые планы страниц. Учебные примеры и справочник будут наполняться и проверяться по реализации.
:::

## Write and repair

Tolerance учитывает знакомые модели формы языка. Диагностика объясняет ограничения и помогает подготовить следующую попытку.

[Совместимость и tolerance](/language/tolerance/) · [Понимание ошибок](/language/errors/)

## Compute and inspect

При включённом наблюдении provenance позволяет исследовать, из каких источников получено значение.

[Происхождение результатов](/results/provenance/)

## Select and uneval

Выбранную часть результата можно связать с воспроизводящим её вычислением.

[Uneval](/results/uneval/)

## Build the environment

EnvCapability объединяет функции, конфигурацию, ресурсы, зависимости и инициализацию среды.

[Первая capability](/capabilities/overview/) · [Опциональная конфигурация](/capabilities/configuration/) · [Ресурсы и disposal](/capabilities/resources/)
