const assert = require("assert");
const {
  normalizeDataTypeSpec,
  normalizeDataTypeSpecForModel,
  resolveEntityReference,
  resolveAttributeReference,
  normalizeActionType,
  isNanoflowDocument,
  resolveErrorHandlingType
} = require("./microflow-builder-template");

function testNormalizeDataTypeSpec() {
  assert.deepEqual(normalizeDataTypeSpec(null), { kind: "Void" });
  assert.deepEqual(normalizeDataTypeSpec("String"), { kind: "String" });
  assert.deepEqual(normalizeDataTypeSpec("Object:MyFirstModule.Task"), {
    kind: "Object",
    entityRef: "MyFirstModule.Task"
  });
  assert.deepEqual(normalizeDataTypeSpec({ kind: "Enumeration", enumerationRef: "MyFirstModule.Status" }), {
    kind: "Enumeration",
    entityRef: "",
    enumerationRef: "MyFirstModule.Status"
  });
}

function testNormalizeDataTypeSpecForModelCoercesEntityNames() {
  const model = {
    findEntityByQualifiedName(qname) {
      if (qname === "MyFirstModule.Customer") return { qualifiedName: qname };
      return null;
    }
  };
  assert.deepEqual(normalizeDataTypeSpecForModel({
    model,
    moduleName: "MyFirstModule",
    typeSpec: "Customer"
  }), {
    kind: "Object",
    entityRef: "Customer"
  });
  assert.deepEqual(normalizeDataTypeSpecForModel({
    model,
    moduleName: "MyFirstModule",
    typeSpec: "String"
  }), {
    kind: "String"
  });
}

function testResolveEntityReference() {
  const model = {
    findEntityByQualifiedName(qname) {
      if (qname === "MyFirstModule.Task") return { qualifiedName: qname };
      return null;
    },
    allDomainModels() {
      return [
        {
          containerAsModule: {
            name: "MyFirstModule"
          }
        }
      ];
    }
  };

  const found1 = resolveEntityReference(model, "MyFirstModule", "Task");
  const found2 = resolveEntityReference(model, "MyFirstModule", "MyFirstModule.Task");
  const missing = resolveEntityReference(model, "MyFirstModule", "Missing");

  assert(found1);
  assert(found2);
  assert.equal(missing, null);
}

function testResolveAttributeReference() {
  const model = {
    findAttributeByQualifiedName(qname) {
      if (qname === "MyFirstModule.Task.Title") return { qualifiedName: qname };
      return null;
    }
  };

  const entity = {
    qualifiedName: "MyFirstModule.Task"
  };

  const found = resolveAttributeReference({
    model,
    entity,
    rawAttributeRef: "Title"
  });
  const missing = resolveAttributeReference({
    model,
    entity,
    rawAttributeRef: "Missing"
  });

  assert(found);
  assert.equal(missing, null);
}

function testNormalizeActionType() {
  assert.equal(normalizeActionType("retrieve_list"), "retrieveList");
  assert.equal(normalizeActionType("create_object"), "createObject");
  assert.equal(normalizeActionType("aggregate_list"), "aggregateList");
  assert.equal(normalizeActionType("create_variable"), "createVariable");
  assert.equal(normalizeActionType("change_object"), "changeObject");
  assert.equal(normalizeActionType("commit_object"), "commitObject");
  assert.equal(normalizeActionType("return_value"), "returnValue");
}

function testIsNanoflowDocument() {
  assert.equal(isNanoflowDocument({ structureTypeName: "Microflows$Nanoflow" }), true);
  assert.equal(isNanoflowDocument({ structureTypeName: "Microflows$Microflow" }), false);
  assert.equal(isNanoflowDocument(null), false);
}

function testResolveErrorHandlingType() {
  const microflows = {
    ErrorHandlingType: {
      Rollback: "Rollback",
      Custom: "Custom",
      CustomWithoutRollBack: "CustomWithoutRollBack",
      Continue: "Continue",
      Abort: "Abort"
    }
  };

  assert.equal(resolveErrorHandlingType(microflows, "continue"), "Continue");
  assert.equal(resolveErrorHandlingType(microflows, "custom_without_rollback"), "CustomWithoutRollBack");
  assert.equal(resolveErrorHandlingType(microflows, "rollback"), "Rollback");
  assert.equal(resolveErrorHandlingType(microflows, "unknown"), null);
  assert.equal(resolveErrorHandlingType(microflows, ""), null);
}

function run() {
  testNormalizeDataTypeSpec();
  testNormalizeDataTypeSpecForModelCoercesEntityNames();
  testResolveEntityReference();
  testResolveAttributeReference();
  testNormalizeActionType();
  testIsNanoflowDocument();
  testResolveErrorHandlingType();
  console.log("microflow builder tests: OK");
}

if (require.main === module) {
  run();
}

module.exports = { run };
