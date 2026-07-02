const assert = require("assert");
const {
  appendModuleRolesFromProjectUserRole,
  appendRequestedSystemModuleRole,
  getDefaultBuiltInSourceUserRoleName,
  getDefaultSystemModuleRoleQname,
  hasRequestedSystemModuleRoleAssignment,
  isBuiltInProjectUserRoleName,
  isOpaqueSystemModuleRolePlaceholder,
  matchesRequestedSystemModuleRole,
  resolveRequestedSystemModuleRole
} = require("./security-builder");

function makeRole({ id = "", name, qualifiedName = "", moduleName = "" }) {
  return {
    id,
    name,
    qualifiedName,
    containerAsModuleSecurity: {
      containerAsModule: {
        name: moduleName
      }
    }
  };
}

async function testMatchesRequestedSystemModuleRoleByBuiltInName() {
  const role = makeRole({ name: "User", moduleName: "System" });
  assert.equal(matchesRequestedSystemModuleRole(role, "System.User"), true);
  assert.equal(matchesRequestedSystemModuleRole(role, "System.Administrator"), false);
}

async function testResolveRequestedSystemModuleRoleFallsBackToBuiltInSeed() {
  const builtInUserModuleRole = makeRole({ id: "sys-user", name: "User", moduleName: "System" });
  const projectSecurity = {
    userRoles: [
      {
        name: "User",
        moduleRoles: [builtInUserModuleRole]
      }
    ]
  };
  const model = {
    findModuleRoleByQualifiedName() {
      return null;
    },
    allModuleRoles() {
      return [];
    }
  };

  const resolved = await resolveRequestedSystemModuleRole({
    model,
    projectSecurity,
    qname: "System.User"
  });

  assert.equal(resolved, builtInUserModuleRole);
}

async function testOpaqueSystemModuleRolePlaceholderIsAccepted() {
  const opaqueRole = makeRole({ id: "opaque-system-role", name: null, qualifiedName: "", moduleName: "" });
  const projectSecurity = {
    userRoles: [
      {
        name: "User",
        moduleRoles: [opaqueRole]
      }
    ]
  };

  assert.equal(isOpaqueSystemModuleRolePlaceholder(opaqueRole), true);
  assert.equal(
    await hasRequestedSystemModuleRoleAssignment({
      assignedRoles: [opaqueRole],
      projectSecurity,
      requestedQname: "System.User"
    }),
    true
  );
}

async function testAppendModuleRolesFromBuiltInProjectRole() {
  const opaqueRole = makeRole({ id: "opaque-system-role", name: null, qualifiedName: "", moduleName: "" });
  const atlasRole = makeRole({ id: "atlas-user", name: "User", qualifiedName: "Atlas_Core.User", moduleName: "Atlas_Core" });
  const projectSecurity = {
    userRoles: [
      {
        name: "User",
        moduleRoles: [opaqueRole, atlasRole]
      }
    ]
  };
  const userRole = { moduleRoles: [] };

  const count = await appendModuleRolesFromProjectUserRole({
    projectSecurity,
    userRole,
    sourceUserRoleName: "User"
  });

  assert.equal(count, 2);
  assert.equal(userRole.moduleRoles.length, 2);
}

async function testAppendModuleRolesFromBuiltInProjectRoleUsesRawQualifiedNamesWhenAvailable() {
  const projectSecurity = {
    userRoles: [
      {
        name: "User",
        moduleRolesQualifiedNames: ["System.User", "MyFirstModule.User"],
        moduleRoles: []
      }
    ]
  };
  let rawValues = [];
  const userRole = {
    moduleRoles: [],
    __moduleRoles: {
      qualifiedNames() {
        return rawValues.slice();
      },
      updateWithRawValue(next) {
        rawValues = next.slice();
      }
    }
  };

  const count = await appendModuleRolesFromProjectUserRole({
    projectSecurity,
    userRole,
    sourceUserRoleName: "User"
  });

  assert.equal(count, 2);
  assert.deepEqual(rawValues, ["System.User", "MyFirstModule.User"]);
  assert.equal(userRole.moduleRoles.length, 0);
}

async function testBuiltInProjectRoleAssignmentsSatisfyRequestedSystemRole() {
  const atlasRole = makeRole({ id: "atlas-user", name: "User", qualifiedName: "Atlas_Core.User", moduleName: "Atlas_Core" });
  const adminRole = makeRole({ id: "admin-user", name: "User", qualifiedName: "Administration.User", moduleName: "Administration" });
  const projectSecurity = {
    userRoles: [
      {
        name: "User",
        moduleRoles: [atlasRole, adminRole]
      }
    ]
  };

  assert.equal(
    await hasRequestedSystemModuleRoleAssignment({
      assignedRoles: [atlasRole],
      projectSecurity,
      requestedQname: "System.User"
    }),
    true
  );
}

async function testManagerDefaultsToSystemUserContract() {
  assert.equal(getDefaultSystemModuleRoleQname("Manager"), "System.User");
  assert.equal(getDefaultBuiltInSourceUserRoleName("Manager"), "User");
}

async function testBuiltInProjectUserRoleNameDetection() {
  assert.equal(isBuiltInProjectUserRoleName("Administrator"), true);
  assert.equal(isBuiltInProjectUserRoleName("User"), true);
  assert.equal(isBuiltInProjectUserRoleName("Supervisor"), false);
}

async function testExplicitAdministratorRequirementUsesAdministratorSeed() {
  const adminSystemRole = makeRole({
    id: "sys-admin",
    name: "Administrator",
    qualifiedName: "System.Administrator",
    moduleName: "System"
  });
  const projectSecurity = {
    userRoles: [
      {
        name: "Administrator",
        moduleRoles: [adminSystemRole]
      }
    ]
  };
  const model = {
    findModuleRoleByQualifiedName() {
      return null;
    },
    allModuleRoles() {
      return [];
    }
  };
  const userRole = { moduleRoles: [] };

  const assignment = await appendRequestedSystemModuleRole({
    model,
    projectSecurity,
    userRole,
    requestedQname: "System.Administrator",
    explicitSourceUserRoleName: "Administrator"
  });

  assert.equal(assignment.assigned, true);
  assert.equal(userRole.moduleRoles.includes(adminSystemRole), true);
  assert.equal(
    await hasRequestedSystemModuleRoleAssignment({
      assignedRoles: userRole.moduleRoles,
      projectSecurity,
      requestedQname: "System.Administrator"
    }),
    true
  );
}

async function testRawQualifiedNameWriteCountsAsSystemRoleAssignment() {
  const projectSecurity = {
    userRoles: []
  };
  const model = {
    findModuleRoleByQualifiedName() {
      return null;
    },
    allModuleRoles() {
      return [];
    }
  };
  let rawValues = [];
  const userRole = {
    moduleRoles: [],
    __moduleRoles: {
      qualifiedNames() {
        return rawValues.slice();
      },
      updateWithRawValue(next) {
        rawValues = next.slice();
      }
    }
  };

  const assignment = await appendRequestedSystemModuleRole({
    model,
    projectSecurity,
    userRole,
    requestedQname: "System.User"
  });

  assert.equal(assignment.assigned, true);
  assert.deepEqual(rawValues, ["System.User"]);
  assert.equal(
    await hasRequestedSystemModuleRoleAssignment({
      assignedRoles: [],
      assignedQualifiedNames: rawValues,
      projectSecurity,
      requestedQname: "System.User"
    }),
    true
  );
}

async function run() {
  await testManagerDefaultsToSystemUserContract();
  await testBuiltInProjectUserRoleNameDetection();
  await testMatchesRequestedSystemModuleRoleByBuiltInName();
  await testResolveRequestedSystemModuleRoleFallsBackToBuiltInSeed();
  await testOpaqueSystemModuleRolePlaceholderIsAccepted();
  await testAppendModuleRolesFromBuiltInProjectRole();
  await testAppendModuleRolesFromBuiltInProjectRoleUsesRawQualifiedNamesWhenAvailable();
  await testBuiltInProjectRoleAssignmentsSatisfyRequestedSystemRole();
  await testExplicitAdministratorRequirementUsesAdministratorSeed();
  await testRawQualifiedNameWriteCountsAsSystemRoleAssignment();
  console.log("security builder tests: OK");
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err.stack || err);
    process.exit(1);
  });
}

module.exports = { run };
