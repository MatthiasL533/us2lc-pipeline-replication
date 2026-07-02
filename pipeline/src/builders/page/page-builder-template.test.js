const assert = require("assert");
const {
  discoverCreatableWidgets,
  createWidgetByClassName,
  getLayoutArgParameterQname,
  setLayoutArgParameterRawQname,
  addContentStep
} = require("./page-builder-template");

function createFakePages() {
  class DynamicText {
    static createInLayoutCallArgumentUnderWidgets(container) {
      const w = { kind: "DynamicText" };
      container.widgets.push(w);
      return w;
    }
  }

  class ActionButton {
    static createInLayoutCallArgumentUnderWidgets(container) {
      const w = { kind: "ActionButton" };
      container.widgets.push(w);
      return w;
    }
  }

  class PageClientAction {
    static createInActionButtonUnderAction(button) {
      const action = { kind: "PageClientAction" };
      button.action = action;
      return action;
    }
    static createInListViewUnderClickAction(widget) {
      const action = { kind: "PageClientAction" };
      widget.clickAction = action;
      return action;
    }
    static createInGridActionButtonUnderAction(button) {
      const action = { kind: "PageClientAction" };
      button.action = action;
      return action;
    }
  }

  class PageSettings {
    static createInPageClientActionUnderPageSettings(action) {
      const settings = { kind: "PageSettings", page: null, parameterMappings: [] };
      action.pageSettings = settings;
      return settings;
    }
    static createInCreateObjectClientActionUnderPageSettings(action) {
      const settings = { kind: "PageSettings", page: null, parameterMappings: [] };
      action.pageSettings = settings;
      return settings;
    }
  }

  class PageParameterMapping {
    static createIn(settings) {
      const mapping = { parameter: null, argument: "" };
      settings.parameterMappings.push(mapping);
      return mapping;
    }
  }

  class ClientTemplate {
    static create() {
      return { template: null, fallback: null };
    }
    static createInWidgetValueUnderTextTemplate(value) {
      const template = { template: null, fallback: null };
      value.textTemplate = template;
      return template;
    }
  }

  class MicroflowClientAction {
    static createInActionButtonUnderAction(button) {
      const action = { kind: "MicroflowClientAction", microflowSettings: { microflow: null } };
      button.action = action;
      return action;
    }
    static createInAttributeWidgetUnderOnChangeAction(widget) {
      const action = {
        kind: "MicroflowClientAction",
        microflowSettings: { microflow: null, asynchronous: false }
      };
      widget.onChangeAction = action;
      return action;
    }
  }

  class CallNanoflowClientAction {
    static createInActionButtonUnderAction(button) {
      const action = { kind: "CallNanoflowClientAction", nanoflow: null };
      button.action = action;
      return action;
    }
    static createInAttributeWidgetUnderOnChangeAction(widget) {
      const action = { kind: "CallNanoflowClientAction", nanoflow: null };
      widget.onChangeAction = action;
      return action;
    }
  }

  class ListView {
    static createInLayoutCallArgumentUnderWidgets(container) {
      const w = { kind: "ListView", dataSource: { entityRef: {} }, widgets: [] };
      container.widgets.push(w);
      return w;
    }
  }

  class DataGrid {
    static createInLayoutCallArgumentUnderWidgets(container) {
      const w = {
        kind: "DataGrid",
        dataSource: { entityRef: {}, searchBar: { items: [] } },
        columns: [],
        controlBar: { items: [], defaultButton: null },
        selectionMode: null
      };
      container.widgets.push(w);
      return w;
    }
  }

  class GridControlBar {
    static createIn(grid) {
      const bar = { kind: "GridControlBar", items: [], defaultButton: null };
      grid.controlBar = bar;
      return bar;
    }
  }

  class GridActionButton {
    static createIn(controlBar) {
      const button = { kind: "GridActionButton", caption: null, action: null };
      controlBar.items.push(button);
      return button;
    }
  }

  class GridColumn {
    static createIn(container) {
      const c = { kind: "GridColumn", attributeRef: {}, name: "" };
      container.columns.push(c);
      return c;
    }
  }

  class ComparisonSearchField {
    static createIn(container) {
      const f = { kind: "ComparisonSearchField", attributeRef: {}, operator: "Contains" };
      container.items.push(f);
      return f;
    }
  }

  class DropDownSearchField {
    static createIn(container) {
      const f = { kind: "DropDownSearchField", attributeRef: {}, xPathConstraint: "" };
      container.items.push(f);
      return f;
    }
  }

  class TextBox {
    static createInLayoutCallArgumentUnderWidgets(container) {
      const w = { kind: "TextBox", attributeRef: null, onChangeAction: null };
      container.widgets.push(w);
      return w;
    }
  }

  class ReferenceSelector {
    static createInLayoutCallArgumentUnderWidgets(container) {
      const w = {
        kind: "ReferenceSelector",
        attributeRef: null,
        selectorSource: { structureTypeName: "Pages$SelectorXPathSource", xPathConstraint: "" },
        renderMode: "DropDown"
      };
      container.widgets.push(w);
      return w;
    }
    static createInDataViewUnderWidgets(container) {
      const w = {
        kind: "ReferenceSelector",
        attributeRef: null,
        selectorSource: { structureTypeName: "Pages$SelectorXPathSource", xPathConstraint: "" },
        renderMode: "DropDown"
      };
      container.widgets.push(w);
      return w;
    }
  }

  class ReferenceSetSelector {
    static createInLayoutCallArgumentUnderWidgets(container) {
      const w = {
        kind: "ReferenceSetSelector",
        constrainedByRefs: [],
        xPathConstraint: ""
      };
      container.widgets.push(w);
      return w;
    }
    static createInDataViewUnderWidgets(container) {
      const w = {
        kind: "ReferenceSetSelector",
        constrainedByRefs: [],
        xPathConstraint: ""
      };
      container.widgets.push(w);
      return w;
    }
  }

  class InputReferenceSetSelector {
    static createInLayoutCallArgumentUnderWidgets(container) {
      const w = {
        kind: "InputReferenceSetSelector",
        attributeRef: null,
        selectorSource: { structureTypeName: "Pages$SelectorXPathSource", xPathConstraint: "" }
      };
      container.widgets.push(w);
      return w;
    }
    static createInDataViewUnderWidgets(container) {
      const w = {
        kind: "InputReferenceSetSelector",
        attributeRef: null,
        selectorSource: { structureTypeName: "Pages$SelectorXPathSource", xPathConstraint: "" }
      };
      container.widgets.push(w);
      return w;
    }
  }

  class DivContainer {
    static createInLayoutCallArgumentUnderWidgets(container) {
      const w = { kind: "DivContainer", widgets: [] };
      container.widgets.push(w);
      return w;
    }
  }

  class SearchBar {
    static create() {
      return { items: [], type: "AlwaysOpen", waitForSearch: false };
    }
  }

  class SetTaskOutcomeClientAction {
    static createInActionButtonUnderAction(button) {
      const action = { kind: "SetTaskOutcomeClientAction", outcomeValue: "", closePage: true, commit: true };
      button.action = action;
      return action;
    }
  }

  class OpenUserTaskClientAction {
    static createInActionButtonUnderAction(button) {
      const action = { kind: "OpenUserTaskClientAction", assignOnOpen: true, openWhenAssigned: false };
      button.action = action;
      return action;
    }
  }

  class SaveChangesClientAction {
    static createInActionButtonUnderAction(button) {
      const action = { kind: "SaveChangesClientAction", closePage: false, syncAutomatically: false };
      button.action = action;
      return action;
    }
  }

  class CreateObjectClientAction {
    static createInActionButtonUnderAction(button) {
      const action = { kind: "CreateObjectClientAction", entityRef: {}, pageSettings: null };
      button.action = action;
      return action;
    }
    static createInGridActionButtonUnderAction(button) {
      const action = { kind: "CreateObjectClientAction", entityRef: {}, pageSettings: null };
      button.action = action;
      return action;
    }
  }

  class DeleteClientAction {
    static createInActionButtonUnderAction(button) {
      const action = { kind: "DeleteClientAction", closePage: false };
      button.action = action;
      return action;
    }
    static createInGridActionButtonUnderAction(button) {
      const action = { kind: "DeleteClientAction", closePage: false };
      button.action = action;
      return action;
    }
  }

  const TextRenderMode = { H2: "H2", Paragraph: "Paragraph" };
  const SearchBarTypeEnum = {
    None: "None",
    FoldableOpen: "FoldableOpen",
    FoldableClosed: "FoldableClosed",
    AlwaysOpen: "AlwaysOpen"
  };
  const ReferenceSelectorRenderModeType = {
    Form: "Form",
    DropDown: "DropDown"
  };
  const SearchFieldOperator = {
    Contains: "Contains",
    StartsWith: "StartsWith",
    Equal: "Equal",
    NotEqual: "NotEqual",
    Greater: "Greater",
    GreaterOrEqual: "GreaterOrEqual",
    Smaller: "Smaller",
    SmallerOrEqual: "SmallerOrEqual"
  };
  const GridSelectionMode = {
    Single: "Single"
  };
  const ClickTypeType = {
    DoubleClick: "DoubleClick"
  };

  return {
    DynamicText,
    ActionButton,
    DivContainer,
    ListView,
    DataGrid,
    GridControlBar,
    GridActionButton,
    GridColumn,
    ComparisonSearchField,
    DropDownSearchField,
    TextBox,
    ReferenceSelector,
    ReferenceSetSelector,
    InputReferenceSetSelector,
    SearchBar,
    PageClientAction,
    PageSettings,
    PageParameterMapping,
    MicroflowClientAction,
    CallNanoflowClientAction,
    OpenUserTaskClientAction,
    SetTaskOutcomeClientAction,
    SaveChangesClientAction,
    CreateObjectClientAction,
    DeleteClientAction,
    ClientTemplate,
    TextRenderMode,
    ReferenceSelectorRenderModeType,
    SearchBarTypeEnum,
    SearchFieldOperator,
    GridSelectionMode,
    ClickTypeType
  };
}

function createFakeTexts() {
  class Text {
    static create() {
      return { translations: [] };
    }
  }
  class Translation {
    static create() {
      return {};
    }
  }
  return { Text, Translation };
}

function createFakeCustomWidgets() {
  class CustomWidget {
    static createInLayoutCallArgumentUnderWidgets(container) {
      const widget = { kind: "CustomWidget", structureTypeName: "CustomWidgets$CustomWidget", object: null, type: null };
      container.widgets.push(widget);
      return widget;
    }
  }

  class CustomWidgetType {
    static createIn(widget) {
      const type = { widgetId: "", name: "", objectType: null };
      widget.type = type;
      return type;
    }
  }

  class WidgetObjectType {
    static createInCustomWidgetTypeUnderObjectType(widgetType) {
      const objectType = { propertyTypes: [] };
      widgetType.objectType = objectType;
      return objectType;
    }
    static createInWidgetValueTypeUnderObjectType(valueType) {
      const objectType = { propertyTypes: [] };
      valueType.objectType = objectType;
      return objectType;
    }
  }

  class WidgetPropertyType {
    static createIn(objectType) {
      const propertyType = { key: "", caption: "", valueType: null };
      objectType.propertyTypes.push(propertyType);
      return propertyType;
    }
  }

  class WidgetValueType {
    static createIn(propertyType) {
      const valueType = { type: "", isList: false, required: false, defaultValue: "", objectType: null };
      propertyType.valueType = valueType;
      return valueType;
    }
  }

  class WidgetObject {
    static createInCustomWidgetUnderObject(widget) {
      const object = { type: null, properties: [] };
      widget.object = object;
      return object;
    }
    static createInWidgetValueUnderObjects(value) {
      const object = { type: null, properties: [] };
      value.objects.push(object);
      return object;
    }
  }

  class WidgetProperty {
    static createIn(widgetObject) {
      const property = { type: null, value: null };
      widgetObject.properties.push(property);
      return property;
    }
  }

  class WidgetValue {
    static createIn(property) {
      const value = {
        type: null,
        primitiveValue: "",
        textTemplate: null,
        attributeRef: null,
        action: null,
        dataSource: null,
        objects: []
      };
      property.value = value;
      return value;
    }
  }

  class CustomWidgetXPathSource {
    static createInWidgetValueUnderDataSource(value) {
      const source = { entityRef: {}, searchBar: { items: [] } };
      value.dataSource = source;
      return source;
    }
  }

  const WidgetValueTypeEnum = {
    String: "String",
    Integer: "Integer",
    Boolean: "Boolean",
    Decimal: "Decimal",
    TextTemplate: "TextTemplate",
    Attribute: "Attribute",
    DataSource: "DataSource",
    Action: "Action",
    Object: "Object"
  };

  return {
    CustomWidget,
    CustomWidgetType,
    WidgetObjectType,
    WidgetPropertyType,
    WidgetValueType,
    WidgetObject,
    WidgetProperty,
    WidgetValue,
    CustomWidgetXPathSource,
    WidgetValueTypeEnum
  };
}

function testDiscoverCreatableWidgets() {
  const pages = createFakePages();
  const widgets = discoverCreatableWidgets(pages);
  assert(widgets.includes("DynamicText"));
  assert(widgets.includes("ActionButton"));
}

function testCreateWidgetByClassName() {
  const pages = createFakePages();
  const container = { widgets: [] };
  const widget = createWidgetByClassName({ pages, className: "DynamicText", container });
  assert.equal(widget.kind, "DynamicText");
  assert.equal(container.widgets.length, 1);
}

function testLayoutArgQnameHelpers() {
  const arg = {
    __parameter: {
      qname: "",
      qualifiedName() {
        return this.qname || null;
      },
      updateWithRawValue(v) {
        this.qname = v;
      }
    }
  };
  assert.equal(getLayoutArgParameterQname(arg), null);
  assert.equal(setLayoutArgParameterRawQname(arg, "Atlas_Core.Atlas_Default.Main"), true);
  assert.equal(getLayoutArgParameterQname(arg), "Atlas_Core.Atlas_Default.Main");
}

function testAddContentStep() {
  const pages = createFakePages();
  const texts = createFakeTexts();
  const model = {};
  const container = { widgets: [] };
  const pageA = { name: "A" };
  const pageB = { name: "B" };
  const pagesByRef = { a: pageA, b: pageB };

  addContentStep({
    pages,
    texts,
    model,
    container,
    pagesByRef,
    step: { type: "dynamicText", text: "Hello", renderMode: "H2" }
  });
  addContentStep({
    pages,
    texts,
    model,
    container,
    pagesByRef,
    step: { type: "buttonToPage", caption: "Go", targetPageRef: "b" }
  });

  assert.equal(container.widgets.length, 2);
  const button = container.widgets[1];
  assert(button.action);
  assert(button.action.pageSettings);
  assert.equal(button.action.pageSettings.page, pageB);
}

function testFlowActionButtons() {
  const pages = createFakePages();
  const texts = createFakeTexts();
  const model = {
    findMicroflowByQualifiedName(qname) {
      return qname === "MyFirstModule.MF_Test" ? { qualifiedName: qname } : null;
    },
    allMicroflows() {
      return [{ name: "MF_Test" }];
    },
    findNanoflowByQualifiedName(qname) {
      return qname === "MyFirstModule.NF_Test" ? { qualifiedName: qname } : null;
    },
    allNanoflows() {
      return [{ name: "NF_Test" }];
    }
  };
  const container = { widgets: [] };

  addContentStep({
    pages,
    texts,
    model,
    moduleName: "MyFirstModule",
    container,
    step: { type: "callMicroflowButton", caption: "Run", microflowRef: "MF_Test" },
    microflowRefsByRef: {}
  });

  addContentStep({
    pages,
    texts,
    model,
    moduleName: "MyFirstModule",
    container,
    step: { type: "callNanoflowButton", caption: "Run Client", nanoflowRef: "NF_Test" },
    nanoflowRefsByRef: {}
  });

  addContentStep({
    pages,
    texts,
    model,
    moduleName: "MyFirstModule",
    container,
    step: { type: "showUserTaskPageButton", caption: "Open Task", assignOnOpen: true, openWhenAssigned: true }
  });

  addContentStep({
    pages,
    texts,
    model,
    moduleName: "MyFirstModule",
    container,
    step: { type: "setTaskOutcomeButton", caption: "Approve", outcomeValue: "Approve" }
  });

  assert.equal(container.widgets.length, 4);
  assert.equal(container.widgets[0].action.kind, "MicroflowClientAction");
  assert.equal(container.widgets[1].action.kind, "CallNanoflowClientAction");
  assert.equal(container.widgets[2].action.kind, "OpenUserTaskClientAction");
  assert.equal(container.widgets[2].action.assignOnOpen, true);
  assert.equal(container.widgets[2].action.openWhenAssigned, true);
  assert.equal(container.widgets[3].action.kind, "SetTaskOutcomeClientAction");
  assert.equal(container.widgets[3].action.outcomeValue, "Approve");
}

function testAttributeInputOnChangeMicroflow() {
  const pages = createFakePages();
  const texts = createFakeTexts();
  const domainmodels = {
    AttributeRef: {
      createInAttributeWidgetUnderAttributeRef(widget) {
        const ref = { attribute: null };
        widget.attributeRef = ref;
        return ref;
      }
    }
  };

  const model = {
    findEntityByQualifiedName(qname) {
      if (qname === "MyFirstModule.Task") return { qualifiedName: qname, name: "Task" };
      return null;
    },
    allDomainModels() {
      return [{ containerAsModule: { name: "MyFirstModule" } }];
    },
    findAttributeByQualifiedName(qname) {
      if (qname === "MyFirstModule.Task.Title") return { qualifiedName: qname, name: "Title" };
      return null;
    },
    findMicroflowByQualifiedName(qname) {
      if (qname === "MyFirstModule.MF_Test") return { qualifiedName: qname };
      return null;
    },
    allMicroflows() {
      return [{ name: "MF_Test" }];
    }
  };

  const container = { widgets: [] };

  addContentStep({
    pages,
    texts,
    model,
    domainmodels,
    moduleName: "MyFirstModule",
    pageSpec: { entityRef: "MyFirstModule.Task" },
    pageContext: null,
    container,
    pagesByRef: {},
    step: {
      type: "attributeInput",
      attributeRef: "Title",
      events: {
        onChangeMicroflowRef: "MF_Test",
        callType: "asynchronous"
      }
    },
    microflowRefsByRef: {}
  });

  assert.equal(container.widgets.length, 1);
  const field = container.widgets[0];
  assert(field.onChangeAction);
  assert.equal(field.onChangeAction.kind, "MicroflowClientAction");
  assert.equal(field.onChangeAction.microflowSettings.asynchronous, true);
}

function testAttributeInputAllowsRawSystemAttributeBinding() {
  const pages = createFakePages();
  const texts = createFakeTexts();
  const domainmodels = {
    AttributeRef: {
      createInAttributeWidgetUnderAttributeRef(widget) {
        const ref = {
          attribute: null,
          __attribute: {
            updated: "",
            updateWithRawValue(v) {
              this.updated = v;
            }
          }
        };
        widget.attributeRef = ref;
        return ref;
      }
    }
  };

  const model = {
    findEntityByQualifiedName() {
      return null;
    },
    findAttributeByQualifiedName() {
      return null;
    },
    allDomainModels() {
      return [];
    }
  };

  const container = { widgets: [] };

  addContentStep({
    pages,
    texts,
    model,
    domainmodels,
    moduleName: "MyFirstModule",
    pageSpec: { entityRef: "System.WorkflowUserTask" },
    pageContext: null,
    container,
    pagesByRef: {},
    step: {
      type: "attributeInput",
      attributeRef: "Name"
    }
  });

  assert.equal(container.widgets.length, 1);
  assert.equal(container.widgets[0].attributeRef.__attribute.updated, "System.WorkflowUserTask.Name");
}

function testDataGridClassicModeSupported() {
  const pages = createFakePages();
  const texts = createFakeTexts();
  const titleAttribute = { qualifiedName: "MyFirstModule.Task.Title", name: "Title" };
  const model = {
    findEntityByQualifiedName() {
      return { qualifiedName: "MyFirstModule.Task", name: "Task" };
    },
    allDomainModels() {
      return [{ containerAsModule: { name: "MyFirstModule" } }];
    },
    findAttributeByQualifiedName(qname) {
      if (qname === "MyFirstModule.Task.Title") return titleAttribute;
      return null;
    }
  };
  const container = { widgets: [] };
  const detailPage = { name: "Task_Detail", qualifiedName: "MyFirstModule.Task_Detail" };

  addContentStep({
    pages,
    texts,
    model,
    domainmodels: {
      AttributeRef: {
        createInMemberWidgetUnderAttributeRef(widget) {
          const ref = { attribute: null };
          widget.attributeRef = ref;
          return ref;
        }
      }
    },
    customwidgets: {},
    moduleName: "MyFirstModule",
    pageSpec: { name: "GridPage", entityRef: "MyFirstModule.Task" },
    pageContext: null,
    container,
    step: {
      type: "dataGrid",
      widgetMode: "classic",
      entityRef: "MyFirstModule.Task",
      columns: [{ attributeRef: "Title" }],
      search: { fields: [{ attributeRef: "Title" }] },
      rowClickTargetPageRef: "task_detail"
    },
    pagesByRef: { task_detail: detailPage },
    pageMetaByRef: {
      task_detail: {
        requiredEntries: [{ parameter: { name: "Task" }, entity: { qualifiedName: "MyFirstModule.Task", name: "Task" } }]
      }
    }
  });

  assert.equal(container.widgets.length, 1);
  assert.equal(container.widgets[0].kind, "DataGrid");
  assert.equal(container.widgets[0].columns.length, 1);
  assert.equal(container.widgets[0].dataSource.searchBar.items.length, 1);
  assert.equal(container.widgets[0].controlBar.defaultButton.kind, "GridActionButton");
  assert.equal(container.widgets[0].controlBar.defaultButton.action.pageSettings.page, detailPage);
  assert.equal(container.widgets[0].controlBar.defaultButton.action.pageSettings.parameterMappings.length, 0);
}

function testCustomWidgetStepSupported() {
  const pages = createFakePages();
  const texts = createFakeTexts();
  const customwidgets = createFakeCustomWidgets();
  const titleAttribute = { qualifiedName: "MyFirstModule.Task.Title", name: "Title" };
  const model = {
    findEntityByQualifiedName(qname) {
      if (qname === "MyFirstModule.Task") return { qualifiedName: qname, name: "Task" };
      return null;
    },
    allDomainModels() {
      return [{ containerAsModule: { name: "MyFirstModule" } }];
    },
    findAttributeByQualifiedName(qname) {
      if (qname === "MyFirstModule.Task.Title") return titleAttribute;
      return null;
    }
  };
  const domainmodels = {
    AttributeRef: {
      createInWidgetValueUnderAttributeRef(value) {
        const ref = { attribute: null };
        value.attributeRef = ref;
        return ref;
      }
    }
  };
  const container = { widgets: [] };

  addContentStep({
    pages,
    texts,
    model,
    domainmodels,
    customwidgets,
    moduleName: "MyFirstModule",
    pageSpec: { name: "ChartPage", entityRef: "MyFirstModule.Task" },
    pageContext: null,
    container,
    pagesByRef: {},
    pageMetaByRef: {},
    step: {
      type: "widget",
      widgetId: "Charts.SampleChart",
      propertyTypes: [
        { key: "title", valueType: "TextTemplate" },
        { key: "seriesAttribute", valueType: "Attribute" }
      ],
      props: {
        title: "Tasks by Title",
        seriesAttribute: "Title"
      }
    }
  });

  assert.equal(container.widgets.length, 1);
  assert.equal(container.widgets[0].kind, "CustomWidget");
  assert.equal(container.widgets[0].type.widgetId, "Charts.SampleChart");
  assert.equal(container.widgets[0].object.properties.length, 2);
}

function testDataGridClassicControlBarButtonsSupported() {
  const pages = createFakePages();
  const texts = createFakeTexts();
  const model = {
    findEntityByQualifiedName(qname) {
      if (qname === "MyFirstModule.Task") return { qualifiedName: qname, name: "Task", id: "task-entity" };
      return null;
    },
    findAttributeByQualifiedName(qname) {
      if (qname === "MyFirstModule.Task.Title") return { qualifiedName: qname, name: "Title" };
      return null;
    }
  };
  const container = { widgets: [] };
  const detailPage = { name: "Task_Detail", qualifiedName: "MyFirstModule.Task_Detail" };

  addContentStep({
    pages,
    texts,
    model,
    domainmodels: {
      DirectEntityRef: {
        createInCreateObjectClientActionUnderEntityRef(action) {
          const ref = { entity: null };
          action.entityRef = ref;
          return ref;
        }
      },
      AttributeRef: {
        createInMemberWidgetUnderAttributeRef(widget) {
          const ref = { attribute: null };
          widget.attributeRef = ref;
          return ref;
        },
        createInGridColumnUnderAttributeRef(widget) {
          const ref = { attribute: null };
          widget.attributeRef = ref;
          return ref;
        }
      }
    },
    customwidgets: {},
    moduleName: "MyFirstModule",
    pageSpec: { name: "GridPage", entityRef: "MyFirstModule.Task" },
    pageContext: null,
    container,
    step: {
      type: "dataGrid",
      widgetMode: "classic",
      entityRef: "MyFirstModule.Task",
      columns: [{ attributeRef: "Title" }],
      controlBarButtons: [
        { type: "createObjectButton", caption: "New Task", targetPageRef: "task_detail" },
        { type: "deleteObjectButton", caption: "Delete Task" }
      ]
    },
    pagesByRef: { task_detail: detailPage },
    pageMetaByRef: {
      task_detail: {
        requiredEntries: [{ parameter: { name: "Task" }, entity: { qualifiedName: "MyFirstModule.Task", name: "Task", id: "task-entity" } }]
      }
    }
  });

  const grid = container.widgets[0];
  assert.equal(grid.kind, "DataGrid");
  assert.equal(grid.controlBar.items.length, 2);
  assert.equal(grid.controlBar.items[0].action.kind, "CreateObjectClientAction");
  assert.equal(grid.controlBar.items[0].action.pageSettings.page, detailPage);
  assert.equal(grid.controlBar.items[1].action.kind, "DeleteClientAction");
  assert.equal(grid.selectionMode, "Single");
}

function testAssociationInputLookup() {
  const pages = createFakePages();
  const texts = { Text: { create(_model) { return { value: "" }; } } };
  const bookTitleAttribute = {
    name: "title",
    qualifiedName: "MyFirstModule.Book.title",
    type: { structureTypeName: "DomainModels$StringAttributeType" }
  };
  const bookEntity = { qualifiedName: "MyFirstModule.Book", name: "Book", attributes: [bookTitleAttribute] };
  const loanEntity = { qualifiedName: "MyFirstModule.Loan", name: "Loan", attributes: [] };
  const assoc = {
    name: "Book_Loan_book",
    qualifiedName: "MyFirstModule.Book_Loan_book",
    parent: bookEntity,
    child: loanEntity,
    type: { name: "Reference" }
  };

  const model = {
    findEntityByQualifiedName(qname) {
      if (qname === "MyFirstModule.Loan") return loanEntity;
      if (qname === "MyFirstModule.Book") return bookEntity;
      return null;
    },
    findAttributeByQualifiedName(qname) {
      if (qname === "MyFirstModule.Book.title") return bookTitleAttribute;
      return null;
    },
    findAssociationByQualifiedName(qname) {
      if (qname === "MyFirstModule.Book_Loan_book") return assoc;
      return null;
    },
    allDomainModels() {
      return [{ containerAsModule: { name: "MyFirstModule" }, associations: [assoc] }];
    }
  };

  const domainmodels = {
    AttributeRef: {
      createInMemberWidgetUnderAttributeRef(widget) {
        const ref = { attribute: null, entityRef: null };
        widget.attributeRef = ref;
        return ref;
      }
    },
    IndirectEntityRef: {
      createInMemberRefUnderEntityRef(attributeRef) {
        const entityRef = { steps: [] };
        attributeRef.entityRef = entityRef;
        return entityRef;
      }
    },
    EntityRefStep: {
      createIn(entityRef) {
        const step = { association: null, destinationEntity: null };
        entityRef.steps.push(step);
        return step;
      }
    }
  };

  const container = { widgets: [] };

  addContentStep({
    pages,
    texts,
    model,
    domainmodels,
    moduleName: "MyFirstModule",
    pageSpec: { name: "Loan_Detail", entityRef: "MyFirstModule.Loan" },
    pageContext: null,
    container,
    pagesByRef: {},
    pageMetaByRef: {},
    step: {
      type: "associationInput",
      targetEntityRef: "MyFirstModule.Book",
      label: "Book"
    }
  });

  assert.equal(container.widgets.length, 1);
  assert.equal(container.widgets[0].kind, "ReferenceSelector");
  assert(container.widgets[0].attributeRef);
  assert.equal(container.widgets[0].attributeRef.attribute, bookTitleAttribute);
  assert(container.widgets[0].attributeRef.entityRef);
  assert.equal(container.widgets[0].attributeRef.entityRef.steps.length, 1);
  assert.equal(container.widgets[0].attributeRef.entityRef.steps[0].association, assoc);
  assert.equal(container.widgets[0].attributeRef.entityRef.steps[0].destinationEntity, bookEntity);
}

function testAssociationSetInputUsesEditableReferenceSetSelector() {
  const pages = createFakePages();
  const texts = { Text: { create(_model) { return { value: "" }; } } };
  const exerciseNameAttribute = {
    name: "Name",
    qualifiedName: "MyFirstModule.Exercise.Name",
    type: { structureTypeName: "DomainModels$StringAttributeType" }
  };
  const workoutEntity = { qualifiedName: "MyFirstModule.Workout", name: "Workout", attributes: [] };
  const exerciseEntity = { qualifiedName: "MyFirstModule.Exercise", name: "Exercise", attributes: [exerciseNameAttribute] };
  const assoc = {
    name: "Workout_Exercise",
    qualifiedName: "MyFirstModule.Workout_Exercise",
    parent: workoutEntity,
    child: exerciseEntity,
    type: { name: "ReferenceSet" }
  };

  const model = {
    findEntityByQualifiedName(qname) {
      if (qname === "MyFirstModule.Workout") return workoutEntity;
      if (qname === "MyFirstModule.Exercise") return exerciseEntity;
      return null;
    },
    findAttributeByQualifiedName(qname) {
      if (qname === "MyFirstModule.Exercise.Name") return exerciseNameAttribute;
      return null;
    },
    findAssociationByQualifiedName(qname) {
      if (qname === "MyFirstModule.Workout_Exercise") return assoc;
      return null;
    },
    allDomainModels() {
      return [{ containerAsModule: { name: "MyFirstModule" }, associations: [assoc] }];
    }
  };

  const domainmodels = {
    AttributeRef: {
      createInMemberWidgetUnderAttributeRef(widget) {
        const ref = { attribute: null, entityRef: null };
        widget.attributeRef = ref;
        return ref;
      }
    },
    IndirectEntityRef: {
      createInMemberRefUnderEntityRef(attributeRef) {
        const entityRef = { steps: [] };
        attributeRef.entityRef = entityRef;
        return entityRef;
      }
    },
    EntityRefStep: {
      createIn(entityRef) {
        const step = { association: null, destinationEntity: null };
        entityRef.steps.push(step);
        return step;
      }
    }
  };

  const container = { widgets: [] };

  addContentStep({
    pages,
    texts,
    model,
    domainmodels,
    moduleName: "MyFirstModule",
    pageSpec: { name: "Workout_Detail", entityRef: "MyFirstModule.Workout" },
    pageContext: null,
    container,
    pagesByRef: {},
    pageMetaByRef: {},
    step: {
      type: "associationSetInput",
      associationRef: "Workout_Exercise",
      targetEntityRef: "MyFirstModule.Exercise",
      label: "Exercise"
    }
  });

  assert.equal(container.widgets.length, 1);
  assert.equal(container.widgets[0].kind, "InputReferenceSetSelector");
  assert(container.widgets[0].attributeRef);
  assert.equal(container.widgets[0].attributeRef.attribute, exerciseNameAttribute);
  assert.equal(container.widgets[0].attributeRef.entityRef.steps.length, 1);
  assert.equal(container.widgets[0].attributeRef.entityRef.steps[0].association, assoc);
  assert.equal(container.widgets[0].attributeRef.entityRef.steps[0].destinationEntity, exerciseEntity);
}

function testListViewStepSupported() {
  const pages = createFakePages();
  const texts = { Text: { create(_model) { return { value: "" }; } } };
  const model = {
    findEntityByQualifiedName(qname) {
      if (qname === "MyFirstModule.Task") return { qualifiedName: qname, name: "Task" };
      return null;
    },
    allDomainModels() {
      return [{ containerAsModule: { name: "MyFirstModule" } }];
    },
    findAttributeByQualifiedName(qname) {
      if (qname === "MyFirstModule.Task.Title") return { qualifiedName: qname, name: "Title" };
      return null;
    }
  };
  const container = { widgets: [] };

  addContentStep({
    pages,
    texts,
    model,
    domainmodels: {},
    customwidgets: {},
    moduleName: "MyFirstModule",
    pageSpec: { name: "Task_Overview", entityRef: "MyFirstModule.Task" },
    pageContext: null,
    container,
    pagesByRef: {},
    pageMetaByRef: {},
    step: {
      type: "listView",
      entityRef: "MyFirstModule.Task",
      templateContent: [{ type: "attributeInput", attributeRef: "Title" }]
    }
  });

  assert.equal(container.widgets.length, 1);
  assert.equal(container.widgets[0].kind, "ListView");
  assert.equal(container.widgets[0].widgets.length, 1);
}

function testListViewAutoRowClickInference() {
  const pages = createFakePages();
  const texts = createFakeTexts();
  const taskEntity = { qualifiedName: "MyFirstModule.Task", name: "Task" };
  const model = {
    findEntityByQualifiedName(qname) {
      if (qname === "MyFirstModule.Task") return taskEntity;
      return null;
    },
    allDomainModels() {
      return [{ containerAsModule: { name: "MyFirstModule" } }];
    }
  };

  const container = { widgets: [] };
  const overviewPage = { name: "Task_Overview", id: "ov1" };
  const detailPage = { name: "Task_Detail", id: "dt1" };
  const detailParameter = { name: "Task" };

  addContentStep({
    pages,
    texts,
    model,
    moduleName: "MyFirstModule",
    pageSpec: { name: "Task_Overview", entityRef: "MyFirstModule.Task" },
    container,
    pagesByRef: { overview: overviewPage, detail: detailPage },
    pageMetaByRef: {
      Task_Overview: { requiredEntries: [] },
      Task_Detail: {
        requiredEntries: [{ parameter: detailParameter, entity: taskEntity }]
      }
    },
    step: {
      type: "listView",
      entityRef: "MyFirstModule.Task",
      templateContent: [{ type: "dynamicText", text: "Item" }]
    }
  });

  assert.equal(container.widgets.length, 1);
  const listView = container.widgets[0];
  assert.equal(listView.kind, "ListView");
  assert(listView.clickAction);
  assert(listView.clickAction.pageSettings);
  assert.equal(listView.clickAction.pageSettings.page, detailPage);
  assert.equal(listView.clickAction.pageSettings.parameterMappings.length, 1);
  assert.equal(listView.clickAction.pageSettings.parameterMappings[0].parameter, detailParameter);
  assert.equal(listView.clickAction.pageSettings.parameterMappings[0].argument, "$currentObject");
}

function testSaveChangesDefaultClosePageTrue() {
  const pages = createFakePages();
  const texts = createFakeTexts();
  const container = { widgets: [] };

  addContentStep({
    pages,
    texts,
    model: {},
    container,
    step: { type: "saveChangesButton", caption: "Save" }
  });

  assert.equal(container.widgets.length, 1);
  const saveButton = container.widgets[0];
  assert.equal(saveButton.kind, "ActionButton");
  assert(saveButton.action);
  assert.equal(saveButton.action.kind, "SaveChangesClientAction");
  assert.equal(saveButton.action.closePage, true);
}

function run() {
  testDiscoverCreatableWidgets();
  testCreateWidgetByClassName();
  testLayoutArgQnameHelpers();
  testAddContentStep();
  testFlowActionButtons();
  testAttributeInputOnChangeMicroflow();
  testAttributeInputAllowsRawSystemAttributeBinding();
  testDataGridClassicModeSupported();
  testDataGridClassicControlBarButtonsSupported();
  testCustomWidgetStepSupported();
  testAssociationInputLookup();
  testAssociationSetInputUsesEditableReferenceSetSelector();
  testListViewStepSupported();
  testListViewAutoRowClickInference();
  testSaveChangesDefaultClosePageTrue();
  console.log("page-builder-template tests: OK");
}

if (require.main === module) {
  run();
}

module.exports = { run };
