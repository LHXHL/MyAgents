import routeFixtures from './appRoute.fixtures.json';
import { describe, expect, it } from 'vitest';

import {
  createSpaceIssueAppRoute,
  createSpaceHomeAppRoute,
  createSpaceIssuesAppRoute,
  createSpaceToolsAppRoute,
  createTaskCommentAppRoute,
  parseAppRouteUrl,
  serializeAppRoute,
} from './appRoute';

describe('AppRoute', () => {
  it('matches the shared native route corpus', () => {
    for (const { url, route } of routeFixtures.accepted) {
      expect(parseAppRouteUrl(url), url).toEqual(route);
      expect(parseAppRouteUrl(serializeAppRoute(route as Parameters<typeof serializeAppRoute>[0]))).toEqual(route);
    }
    for (const url of routeFixtures.rejected) expect(parseAppRouteUrl(url), url).toBeNull();
    const market = createSpaceToolsAppRoute('official');
    expect(serializeAppRoute(market)).toBe('myagents://open/v1/spaces/official/tools');
    expect(() => createSpaceToolsAppRoute('')).toThrow();
    expect(() => createSpaceToolsAppRoute('x'.repeat(201))).toThrow();
  });

  it('round-trips supported v1 routes', () => {
    expect(serializeAppRoute(createSpaceHomeAppRoute())).toBe('myagents://open/v1/spaces');
    expect(serializeAppRoute(createSpaceIssuesAppRoute('myagents'))).toBe('myagents://open/v1/spaces/myagents/issues');
    const route = createSpaceIssueAppRoute('space_1', 'issue-2');
    expect(serializeAppRoute(route)).toBe(
      'myagents://open/v1/spaces/space_1/issues/issue-2',
    );
    expect(parseAppRouteUrl(serializeAppRoute(route))).toEqual(route);

    const commentRoute = createTaskCommentAppRoute('task_1', 'comment-2');
    expect(serializeAppRoute(commentRoute)).toBe(
      'myagents://open/v1/tasks/task_1/comments/comment-2',
    );
    expect(parseAppRouteUrl(serializeAppRoute(commentRoute))).toEqual(commentRoute);
  });

  it.each([
    'myagents://attachment/session/file.png',
    'myagents://tool-attachment/session/turn/file.png',
    'myagents-resource://attachment/session/file.png',
    'myagents://evil/v1/spaces/a/issues/b',
    'myagents://open/v2/spaces/a/issues/b',
    'myagents://open/v1/spaces/a/issues/b/extra',
    'myagents://open/v1/tasks/a/comments/b/extra',
    'myagents://open/v1/tasks/a/issues/b',
    'myagents://open/v1/spaces/a/issues/b?prompt=run',
    'myagents://open/v1/spaces/a/issues/b#fragment',
    'myagents://open/v1/spaces/a%2Fb/issues/c',
    'myagents://open/v1/spaces/a/issues/%ZZ',
    'myagents://user@open/v1/spaces/a/issues/b',
    'myagents://open:42/v1/spaces/a/issues/b',
  ])('rejects unsupported or ambiguous input: %s', (value) => {
    expect(parseAppRouteUrl(value)).toBeNull();
  });

  it('bounds identifiers before serialization', () => {
    expect(() => createSpaceIssuesAppRoute('')).toThrow();
    expect(() => createSpaceIssuesAppRoute('x'.repeat(201))).toThrow();
    expect(() => createSpaceIssueAppRoute('', 'issue')).toThrow();
    expect(() => createSpaceIssueAppRoute('space', 'x'.repeat(201))).toThrow();
    expect(() => createTaskCommentAppRoute('task', '')).toThrow();
  });
});
