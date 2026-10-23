import { describe, expect, it } from 'vitest';
import { assertTestPomDependenciesUnchanged } from '../content-policy.js';
const pom = (version: string, property = '1-SNAPSHOT') => `<project><properties><library.version>${property}</library.version></properties><dependencies><dependency><groupId>org.test</groupId><artifactId>library</artifactId><version>${version}</version></dependency></dependencies></project>`;
describe('test dependency version policy', () => {
  it('preserves existing dependency version values and the properties used by them', () => {
    expect(() => assertTestPomDependenciesUnchanged(pom('${library.version}'), pom('${library.version}', '2-SNAPSHOT'))).toThrow(/unchanged/);
    expect(() => assertTestPomDependenciesUnchanged(pom('1-SNAPSHOT'), pom('1'))).toThrow(/unchanged/);
    expect(() => assertTestPomDependenciesUnchanged(pom('1-SNAPSHOT'), pom('1-SNAPSHOT').replace('</project>', '<name>Updated</name></project>'))).not.toThrow();
  });
  it('rejects release dependencies and malformed pom input', () => {
    expect(() => assertTestPomDependenciesUnchanged('<project/>', pom('1'))).toThrow(/SNAPSHOT/);
    expect(() => assertTestPomDependenciesUnchanged('<project/>', '<project>')).toThrow(/malformed/);
    expect(() => assertTestPomDependenciesUnchanged('<project/>', pom('1-SNAPSHOT'))).not.toThrow();
  });
  it('follows chained version properties and rejects cyclic expansion', () => {
    const nested = (version: string) => pom('${library.version}', '${revision}').replace('</properties>', `<revision>${version}</revision></properties>`);
    expect(() => assertTestPomDependenciesUnchanged(nested('1-SNAPSHOT'), nested('2-SNAPSHOT'))).toThrow(/unchanged/);
    expect(() => assertTestPomDependenciesUnchanged(nested('1-SNAPSHOT'), nested('${library.version}'))).toThrow(/Cyclic/);
  });
  it('validates profile overrides without confusing profile order', () => {
    const profile = (id: string, version: string) => `<profile><id>${id}</id><properties><library.version>${version}</library.version></properties><dependencies><dependency><groupId>a</groupId><artifactId>b</artifactId><version>\${library.version}</version></dependency></dependencies></profile>`;
    const wrap = (profiles: string) => `<project><profiles>${profiles}</profiles></project>`;
    const original = wrap(profile('first', '1-SNAPSHOT') + profile('second', '2-SNAPSHOT'));
    expect(() => assertTestPomDependenciesUnchanged(original, wrap(profile('second', '2-SNAPSHOT') + profile('first', '1-SNAPSHOT')))).not.toThrow();
    expect(() => assertTestPomDependenciesUnchanged(original, wrap(profile('first', '3-SNAPSHOT') + profile('second', '2-SNAPSHOT')))).toThrow(/unchanged/);
  });
});
