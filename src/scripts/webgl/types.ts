export type UniformValue = { value: any; type?: string };

export type Uniforms = Record<string, UniformValue>;

export type Defines = Record<string, string | number | boolean>;
