// Create a page where we show a success message for siging up
import { Button, Card, Col, Result, Row, Typography } from 'antd';
import React from 'react';

export default function Success() {
  return (
    <div className="page-container">
      <Typography.Title>Thank you! You're appreciated 🥳</Typography.Title>
      <Row justify="center">
        <Col span={8}>
          <Card>
            <Result
              status="success"
              title="You're all set"
              subTitle="You can now add the extension to your GitHub repo."
              extra={
                <Button type="primary" onClick={() => {}}>
                  Add Extension
                </Button>
              }
            />
          </Card>
        </Col>
      </Row>
      <br />
      <Row justify="center">
        <Col span={8}>
          <Card title="How To Use?">
            <Typography.Text>
              Add a comment to your PR that says
              <code>@explainthispr</code> and we will analyze your code to add a
              comment explaining the changes.
            </Typography.Text>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
